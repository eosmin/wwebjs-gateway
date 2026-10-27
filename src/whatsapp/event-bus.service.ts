import { Injectable, Logger } from '@nestjs/common'

import type { EventEnvelope, WaEventName } from '../types/events.js'

// Subscribers may be async; the bus never awaits them
export type EventHandler<E extends WaEventName = WaEventName> = (
  envelope: EventEnvelope<E>
) => void | Promise<void>

export type Unsubscribe = () => void

// Wildcard subscription: every event, whatever its name
export const ALL_EVENTS = '*'

type Subscription = WaEventName | typeof ALL_EVENTS

interface Subscriber {
  readonly handler: EventHandler
  active: boolean
}

// The in-process fan-out between the event pipeline (publisher) and the Socket.IO gateway and the
// webhook dispatcher (subscribers). Delivery is synchronous: the handlers of the event first, then
// the wildcard ones, each group in subscription order. One failing subscriber never stops the
// others nor the publisher. A subscriber added during a delivery waits for the next event; one
// removed during it is skipped.
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name)
  private readonly subscribers = new Map<Subscription, Set<Subscriber>>()

  subscribe<E extends WaEventName>(event: E, handler: EventHandler<E>): Unsubscribe
  subscribe(event: typeof ALL_EVENTS, handler: EventHandler): Unsubscribe
  subscribe(event: Subscription, handler: EventHandler<never>): Unsubscribe {
    // The overloads keep each handler paired with its event; the map only stores them type-erased
    const subscriber: Subscriber = { handler: handler as unknown as EventHandler, active: true }
    const set = this.subscribers.get(event) ?? new Set<Subscriber>()
    set.add(subscriber)
    this.subscribers.set(event, set)

    // Per subscription, so subscribing the same function twice gives two independent registrations
    return () => {
      subscriber.active = false
      set.delete(subscriber)
      if (set.size === 0 && this.subscribers.get(event) === set) this.subscribers.delete(event)
    }
  }

  publish(envelope: EventEnvelope): void {
    const targets = [
      ...(this.subscribers.get(envelope.event) ?? []),
      ...(this.subscribers.get(ALL_EVENTS) ?? [])
    ]
    for (const subscriber of targets) {
      if (subscriber.active) this.deliver(subscriber.handler, envelope)
    }
  }

  private deliver(handler: EventHandler, envelope: EventEnvelope): void {
    try {
      const result = handler(envelope)
      // Promise.resolve also adopts non-native thenables, which `instanceof Promise` would miss
      if (result) void Promise.resolve(result).catch(error => this.logFailure(envelope, error))
    } catch (error) {
      this.logFailure(envelope, error)
    }
  }

  // Identifiers and the error class only: an error message can echo message content
  private logFailure(envelope: EventEnvelope, error: unknown): void {
    const kind = error instanceof Error ? error.name : typeof error
    this.logger.error(
      `Subscriber failed on ${envelope.event} (session ${envelope.sessionId}, seq ${envelope.seq}): ${kind}`
    )
  }
}
