import { Logger } from '@nestjs/common'

// At most one write per session in this time: a busy chat must not turn into a write per message
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000

export interface ActivityStore {
  // Sets `lastEventAt` of the session
  save(sessionId: string, at: Date): Promise<void>
}

interface ActivityState {
  // The latest activity noted so far; an older one never replaces it
  latest: number
  // The latest activity not written yet
  pending: number | undefined
  // The write in progress, so the next one and the flush start after it
  saving: Promise<void> | undefined
  // When the last write started; 0 before the first one
  savedAt: number
  timer: NodeJS.Timeout | undefined
}

// Keeps `sessions.lastEventAt` close to the last incoming message a session received, which is the
// baseline the reconciler compares the chats against. It is the time the sender wrote the message
// (never later than now), and it only moves forward: after a restart WhatsApp may deliver the
// messages of the downtime as live events, and those must not make the baseline look recent. The
// first message writes at once, the rest at most once per interval, and `flush` writes what is
// left when the session stops. A write that fails is kept and tried again later; it never reaches
// the caller.
export class ActivityRecorder {
  private readonly logger = new Logger(ActivityRecorder.name)
  private readonly states = new Map<string, ActivityState>()

  constructor(private readonly store: ActivityStore) {}

  note(sessionId: string, at: number): void {
    const state = this.stateOf(sessionId)
    const when = Math.min(at, Date.now())
    if (when <= state.latest) return
    state.latest = when
    state.pending = when
    if (state.timer) return
    const waitMs = Math.max(0, state.savedAt + ACTIVITY_WRITE_INTERVAL_MS - Date.now())
    if (waitMs === 0) void this.write(sessionId, state, true)
    else this.schedule(sessionId, state, waitMs)
  }

  // Writes what is pending now, after the write in progress, for a session that stops. A failure
  // is logged and not retried: the session is gone.
  async flush(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId)
    if (!state) return
    this.cancel(state)
    await this.write(sessionId, state, false)
  }

  // The session was deleted: there is no row left to write to
  forget(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state) this.cancel(state)
    this.states.delete(sessionId)
  }

  private stateOf(sessionId: string): ActivityState {
    const known = this.states.get(sessionId)
    if (known) return known
    const state: ActivityState = {
      latest: 0,
      pending: undefined,
      saving: undefined,
      savedAt: 0,
      timer: undefined
    }
    this.states.set(sessionId, state)
    return state
  }

  private schedule(sessionId: string, state: ActivityState, waitMs: number): void {
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.write(sessionId, state, true)
    }, waitMs)
    state.timer.unref()
  }

  private cancel(state: ActivityState): void {
    clearTimeout(state.timer)
    state.timer = undefined
  }

  // Writes run one after another, so an older value can never land after a newer one
  private write(sessionId: string, state: ActivityState, retry: boolean): Promise<void> {
    const run = (state.saving ?? Promise.resolve()).then(() => this.save(sessionId, state, retry))
    state.saving = run
    return run
  }

  private async save(sessionId: string, state: ActivityState, retry: boolean): Promise<void> {
    const at = state.pending
    if (at === undefined) return
    state.pending = undefined
    state.savedAt = Date.now()
    try {
      await this.store.save(sessionId, new Date(at))
    } catch (error: unknown) {
      // A newer activity noted meanwhile wins
      state.pending ??= at
      if (retry && !state.timer && this.states.get(sessionId) === state) {
        this.schedule(sessionId, state, ACTIVITY_WRITE_INTERVAL_MS)
      }
      const kind = error instanceof Error ? error.name : typeof error
      this.logger.warn(`[${sessionId}] Saving the last activity failed (${kind})`)
    }
  }
}
