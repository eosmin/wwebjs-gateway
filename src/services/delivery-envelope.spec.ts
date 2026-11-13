import { WA_EVENT_NAMES } from '../types/events.js'

import { DeliveryEnvelope } from './delivery-queue.service.js'

const envelope = (event: string) => ({
  id: 'evt_1',
  event,
  sessionId: 'main',
  seq: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  data: {}
})

// The event name travels in the X-Gateway-Event header: it must be a name, never text that could carry
// a line break or break the request
describe('DeliveryEnvelope event', () => {
  it.each([...WA_EVENT_NAMES, 'message_batch', 'ping'])('takes the event %s', event => {
    expect(DeliveryEnvelope.safeParse(envelope(event)).success).toBe(true)
  })

  it.each(['', 'Message', 'a b', 'message\r\nx-injected: 1', 'é', `a${'b'.repeat(64)}`])(
    'refuses the event %j',
    event => {
      expect(DeliveryEnvelope.safeParse(envelope(event)).success).toBe(false)
    }
  )
})
