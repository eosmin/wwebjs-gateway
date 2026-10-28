import { Logger } from '@nestjs/common'

// How many `seq` numbers are reserved in the database at a time. A crash costs a gap of at most
// this many numbers; a larger block writes less often and leaves bigger gaps.
export const SEQ_BLOCK_SIZE = 100
// After a failed write of the bound, the next try waits this long, so a database that is down does
// not slow down every event
export const SEQ_RETRY_MS = 5000

export interface SeqStore {
  // `INCR seq:<id>`
  increment(sessionId: string): Promise<number>
  // `SET seq:<id> value`
  set(sessionId: string, value: number): Promise<void>
  // The reserved upper bound kept in the database (0 for a session that never delivered)
  loadReserved(sessionId: string): Promise<number>
  // Only ever raises the bound, so a write that arrives late cannot lower what a newer one set
  raiseReserved(sessionId: string, value: number): Promise<void>
  // Sets the bound whatever it was; for the shutdown, when nothing else writes any more
  setReserved(sessionId: string, value: number): Promise<void>
}

interface SeqState {
  // The last `seq` handed out
  last: number
  // No `seq` above this one was handed out before it was written to the database, unless a write
  // failed (`retryAt` says when the next try is)
  reserved: number
  retryAt: number
}

// Hands out the `seq` of each session so that it only ever grows, even when Redis forgets. Redis
// holds the counter, but with AOF `everysec` a crash loses about a second of increments, and a
// counter that goes back would repeat numbers already delivered. Two guards cover that:
//
// - the database holds a reserved upper bound, written ahead (before the first `seq` above it is
//   used), so after a restart of the gateway the counter starts above everything ever delivered;
// - the memory holds the last `seq`, so when Redis loses increments while the gateway runs, the
//   counter is lifted above it.
//
// The state of a session stays in memory from its first `seq` until `forget`: events keep coming
// after a session stops (its last `session_status`), and they must continue the same count.
// `next` is called one at a time per session (EventSequencer).
//
// Numbers are never reused but may skip: after a crash the gap is at most SEQ_BLOCK_SIZE.
export class SeqAllocator {
  private readonly logger = new Logger(SeqAllocator.name)
  private readonly sessions = new Map<string, SeqState>()

  constructor(private readonly store: SeqStore) {}

  // Reads the reserved bound of the session; the next `seq` will be above it. What the memory
  // already knows is never lowered. Rejects when the database cannot be read: starting without the
  // bound would risk repeating numbers.
  async open(sessionId: string): Promise<void> {
    const reserved = await this.store.loadReserved(sessionId)
    const known = this.sessions.get(sessionId)
    if (!known) {
      this.sessions.set(sessionId, { last: reserved, reserved, retryAt: 0 })
      return
    }
    // In place: a `next` that is waiting on the store holds this very object
    known.last = Math.max(known.last, reserved)
    known.reserved = Math.max(known.reserved, reserved)
  }

  async next(sessionId: string): Promise<number> {
    if (!this.sessions.has(sessionId)) await this.open(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error('seq state vanished')
    let seq = await this.store.increment(sessionId)
    if (seq <= state.last) {
      seq = state.last + 1
      await this.store.set(sessionId, seq)
    }
    state.last = seq
    if (seq > state.reserved && Date.now() >= state.retryAt)
      await this.reserve(sessionId, state, seq)
    return seq
  }

  // The session is gone for good: a session created again under the same id starts from zero
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  // At shutdown, once nothing publishes any more: the bound is set to the last `seq` (down from the
  // reserved block, or up when a reservation had failed), so the next boot leaves no gap. Best
  // effort; a failure only leaves the gap.
  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.sessions].map(async ([sessionId, state]) => {
        if (state.last === state.reserved) return
        try {
          await this.store.setReserved(sessionId, state.last)
          state.reserved = state.last
        } catch {
          this.logger.warn(`[${sessionId}] Saving the seq bound failed; the next boot leaves a gap`)
        }
      })
    )
  }

  // A failure is logged and the stream goes on, so the guarantee is best effort while the database
  // does not answer; the next try comes after SEQ_RETRY_MS and covers the numbers handed out since
  private async reserve(sessionId: string, state: SeqState, seq: number): Promise<void> {
    const reserved = seq + SEQ_BLOCK_SIZE - 1
    try {
      await this.store.raiseReserved(sessionId, reserved)
      state.reserved = reserved
    } catch {
      state.retryAt = Date.now() + SEQ_RETRY_MS
      this.logger.warn(`[${sessionId}] Reserving seq ${seq}-${reserved} failed; retrying soon`)
    }
  }
}
