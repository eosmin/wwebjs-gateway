import { Logger } from '@nestjs/common'

import type { EventEnvelope, WaEventName } from '../types/events.js'

import { ALL_EVENTS, EventBusService } from './event-bus.service.js'

const ready = (seq = 1): EventEnvelope<'ready'> => ({
  id: `evt_ready-${seq}`,
  event: 'ready',
  sessionId: 'support-line',
  seq,
  timestamp: '2026-10-27T12:00:00.000Z',
  data: {}
})

const qr = (text = 'qr-text'): EventEnvelope<'qr'> => ({
  id: 'evt_qr-1',
  event: 'qr',
  sessionId: 'support-line',
  seq: 2,
  timestamp: '2026-10-27T12:00:01.000Z',
  data: { qr: text }
})

// Two microtask turns: the rejection is observed by `.catch`, which runs one turn later
const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('EventBusService', () => {
  let bus: EventBusService
  let errors: string[]

  beforeEach(() => {
    bus = new EventBusService()
    errors = []
    jest.spyOn(Logger.prototype, 'error').mockImplementation(message => {
      errors.push(String(message))
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('delivers an envelope to the subscribers of its event, typed by event name', () => {
    const received: string[] = []
    bus.subscribe('qr', envelope => {
      // `data.qr` only type-checks because the handler is narrowed to the `qr` event
      received.push(envelope.data.qr)
    })

    bus.publish(qr('abc'))

    expect(received).toEqual(['abc'])
  })

  it('does not deliver events to subscribers of another event', () => {
    const handler = jest.fn()
    bus.subscribe('qr', handler)

    bus.publish(ready())

    expect(handler).not.toHaveBeenCalled()
  })

  it('delivers every event to a wildcard subscriber', () => {
    const names: WaEventName[] = []
    bus.subscribe(ALL_EVENTS, envelope => {
      names.push(envelope.event)
    })

    bus.publish(ready())
    bus.publish(qr())

    expect(names).toEqual(['ready', 'qr'])
  })

  it('calls the subscribers in subscription order, specific ones before the wildcard', () => {
    const order: string[] = []
    bus.subscribe(ALL_EVENTS, () => {
      order.push('all')
    })
    bus.subscribe('ready', () => {
      order.push('first')
    })
    bus.subscribe('ready', () => {
      order.push('second')
    })

    bus.publish(ready())

    expect(order).toEqual(['first', 'second', 'all'])
  })

  it('stops delivering after unsubscribe, and unsubscribing twice is harmless', () => {
    const handler = jest.fn()
    const unsubscribe = bus.subscribe('ready', handler)

    bus.publish(ready(1))
    unsubscribe()
    unsubscribe()
    bus.publish(ready(2))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('lets a handler unsubscribe itself without skipping the next one', () => {
    const calls: string[] = []
    const unsubscribe = bus.subscribe('ready', () => {
      calls.push('self')
      unsubscribe()
    })
    bus.subscribe('ready', () => {
      calls.push('next')
    })

    bus.publish(ready(1))
    bus.publish(ready(2))

    expect(calls).toEqual(['self', 'next', 'next'])
  })

  it('skips a handler that an earlier handler unsubscribed during the same delivery', () => {
    const second = jest.fn()
    let unsubscribeSecond: () => void = () => undefined
    bus.subscribe('ready', () => {
      unsubscribeSecond()
    })
    unsubscribeSecond = bus.subscribe('ready', second)

    bus.publish(ready(1))

    expect(second).not.toHaveBeenCalled()
  })

  it('does not deliver the in-flight event to a handler subscribed during the delivery', () => {
    const late = jest.fn()
    bus.subscribe('ready', () => {
      bus.subscribe('ready', late)
    })

    bus.publish(ready(1))

    expect(late).not.toHaveBeenCalled()
  })

  it('keeps independent registrations when the same function subscribes twice', () => {
    const handler = jest.fn()
    const first = bus.subscribe('ready', handler)
    bus.subscribe('ready', handler)

    bus.publish(ready(1))
    first()
    bus.publish(ready(2))

    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('calls the same function twice when it subscribes to an event and to the wildcard', () => {
    const handler = jest.fn()
    bus.subscribe('ready', handler)
    bus.subscribe(ALL_EVENTS, handler)

    bus.publish(ready())

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes a wildcard subscription and keeps the other handlers of the event', () => {
    const wildcard = jest.fn()
    const other = jest.fn()
    const unsubscribe = bus.subscribe(ALL_EVENTS, wildcard)
    bus.subscribe('ready', other)

    unsubscribe()
    bus.publish(ready())

    expect(wildcard).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale unsubscribe after the event was subscribed again', () => {
    const stale = bus.subscribe('ready', jest.fn())
    stale()
    const handler = jest.fn()
    bus.subscribe('ready', handler)

    stale()
    bus.publish(ready())

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('supports a handler that publishes re-entrantly', () => {
    const names: string[] = []
    bus.subscribe('ready', () => {
      bus.publish(qr())
    })
    bus.subscribe('qr', envelope => {
      names.push(envelope.event)
    })

    bus.publish(ready())

    expect(names).toEqual(['qr'])
  })

  it('does nothing when nobody subscribed', () => {
    expect(() => bus.publish(ready())).not.toThrow()
  })

  it('isolates a throwing subscriber; the log has the identifiers, never message or payload', () => {
    const after = jest.fn()
    bus.subscribe('qr', () => {
      throw new Error('echoes secret-qr-string')
    })
    bus.subscribe('qr', after)

    expect(() => bus.publish(qr('secret-qr-string'))).not.toThrow()

    expect(after).toHaveBeenCalledTimes(1)
    expect(errors).toEqual(['Subscriber failed on qr (session support-line, seq 2): Error'])
  })

  it('isolates a throwing wildcard subscriber from the specific and the later ones', () => {
    const specific = jest.fn()
    const laterWildcard = jest.fn()
    bus.subscribe('ready', specific)
    bus.subscribe(ALL_EVENTS, () => {
      throw new Error('boom')
    })
    bus.subscribe(ALL_EVENTS, laterWildcard)

    expect(() => bus.publish(ready())).not.toThrow()

    expect(specific).toHaveBeenCalledTimes(1)
    expect(laterWildcard).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('logs every failing subscriber', () => {
    for (let i = 0; i < 2; i += 1) {
      bus.subscribe('ready', () => {
        throw new Error('boom')
      })
    }

    bus.publish(ready())

    expect(errors).toHaveLength(2)
  })

  it('isolates an async subscriber that rejects', async () => {
    const after = jest.fn()
    bus.subscribe('ready', () => Promise.reject(new Error('async boom')))
    bus.subscribe('ready', after)

    bus.publish(ready())
    expect(after).toHaveBeenCalledTimes(1)
    await flushPromises()

    expect(errors).toEqual(['Subscriber failed on ready (session support-line, seq 1): Error'])
  })

  it('logs the rejection of a non-native thenable', async () => {
    const thenable = {
      then: (_resolve: () => void, reject: (reason: unknown) => void): void => {
        reject(new TypeError('thenable boom'))
      }
    } as unknown as Promise<void> // reason: simulates a handler returning another realm's promise
    bus.subscribe('ready', () => thenable)

    bus.publish(ready())
    await flushPromises()

    expect(errors).toEqual(['Subscriber failed on ready (session support-line, seq 1): TypeError'])
  })

  it('does not wait for a handler that never settles', () => {
    const after = jest.fn()
    bus.subscribe('ready', () => new Promise<void>(() => undefined))
    bus.subscribe('ready', after)

    bus.publish(ready())

    expect(after).toHaveBeenCalledTimes(1)
  })

  it('logs a thrown non-Error value by its type', () => {
    bus.subscribe('ready', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the bus must survive any thrown value
      throw 'plain string'
    })

    bus.publish(ready())

    expect(errors).toEqual(['Subscriber failed on ready (session support-line, seq 1): string'])
  })
})
