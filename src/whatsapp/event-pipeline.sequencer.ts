import { randomUUID } from 'node:crypto'

import type { EventEnvelope, WaEventName, WaEventPayloadMap } from '../types/events.js'

export type Emit = <E extends WaEventName>(event: E, data: WaEventPayloadMap[E]) => Promise<void>

export interface SequencerPorts {
  // The next `seq` of the session; the pipeline backs it with a Redis INCR
  nextSeq(sessionId: string): Promise<number>
  publish(envelope: EventEnvelope): void
}

// The only place that stamps `seq` and hands an event to the bus. Per session, the stamp and the
// publish of one event finish before the next event starts, so `seq` order is also delivery order
// whoever publishes (the pipeline, the session manager, the send queue).
export class EventSequencer {
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(private readonly ports: SequencerPorts) {}

  publish<E extends WaEventName>(
    sessionId: string,
    event: E,
    data: WaEventPayloadMap[E]
  ): Promise<void> {
    return this.run(sessionId, emit => emit(event, data))
  }

  // Runs `task` while no other event of the session is stamped, so the events it emits are
  // consecutive: a batch cannot be overtaken halfway. A failed task does not stop the next one.
  run<T>(sessionId: string, task: (emit: Emit) => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(() => task(this.emitFor(sessionId)))
    const tail = result.catch(() => undefined)
    this.tails.set(sessionId, tail)
    // The session leaves the map once idle, so removed sessions leave nothing behind
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    })
    return result
  }

  private emitFor(sessionId: string): Emit {
    return async (event, data) => {
      const seq = await this.ports.nextSeq(sessionId)
      // `event` and `data` are paired by the signature of Emit; the union cannot express it here
      const envelope = {
        id: `evt_${randomUUID()}`,
        event,
        sessionId,
        seq,
        timestamp: new Date().toISOString(),
        data
      } as unknown as EventEnvelope
      this.ports.publish(envelope)
    }
  }
}
