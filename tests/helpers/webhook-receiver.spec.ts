import { createHmac } from 'node:crypto'

import {
  OrderedConsumer,
  type ReceivedEvent,
  WebhookReceiver,
  verifySignature
} from './webhook-receiver.js'

const SECRET = 'whsec_vector'
const NOW = 1767225600
const BODY = '{"id":"evt_1","seq":7}'
// The reference vector of docs/webhooks.md
const VECTOR = 'sha256=4e7cd92215110c8a5c9eaefa53663c809c974cb2a6ebebc753d9acc29a849b32'

const options = { toleranceSeconds: 300, nowSeconds: NOW }
const headers = (over: Record<string, string> = {}) => ({
  'x-gateway-timestamp': String(NOW),
  'x-gateway-signature': VECTOR,
  ...over
})

describe('verifySignature', () => {
  it('accepts the reference vector of the documentation', () => {
    expect(verifySignature(SECRET, headers(), BODY, options)).toEqual({ ok: true })
  })

  it.each([
    ['another secret', () => verifySignature('whsec_other', headers(), BODY, options)],
    ['a changed body', () => verifySignature(SECRET, headers(), `${BODY} `, options)],
    [
      'a signature of another timestamp',
      () =>
        verifySignature(SECRET, headers({ 'x-gateway-timestamp': String(NOW + 1) }), BODY, options)
    ],
    [
      'a signature that is not hex',
      () => verifySignature(SECRET, headers({ 'x-gateway-signature': 'sha256=zz' }), BODY, options)
    ],
    [
      'a signature cut short',
      () =>
        verifySignature(
          SECRET,
          headers({ 'x-gateway-signature': VECTOR.slice(0, 20) }),
          BODY,
          options
        )
    ],
    [
      'another scheme',
      () =>
        verifySignature(
          SECRET,
          headers({ 'x-gateway-signature': VECTOR.replace('sha256=', 'md5=') }),
          BODY,
          options
        )
    ]
  ])('refuses %s', (_name, verify) => {
    expect(verify().ok).toBe(false)
  })

  it('refuses a request without its headers', () => {
    expect(verifySignature(SECRET, {}, BODY, options).ok).toBe(false)
    expect(verifySignature(SECRET, { 'x-gateway-timestamp': String(NOW) }, BODY, options).ok).toBe(
      false
    )
  })

  const signedAt = (timestamp: number) => {
    const signature = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex')}`
    return headers({
      'x-gateway-timestamp': String(timestamp),
      'x-gateway-signature': signature
    })
  }

  it('refuses a timestamp past the tolerance, old or in the future, even with a valid signature', () => {
    expect(verifySignature(SECRET, signedAt(NOW - 301), BODY, options).ok).toBe(false)
    expect(verifySignature(SECRET, signedAt(NOW + 301), BODY, options).ok).toBe(false)
    expect(verifySignature(SECRET, signedAt(NOW - 300), BODY, options).ok).toBe(true)
  })
})

const event = (seq: number, deliveryId = `d${seq}`, sessionId = 's1'): ReceivedEvent => ({
  deliveryId,
  event: 'message',
  sessionId,
  seq,
  data: {},
  envelope: {}
})
const seqs = (events: ReceivedEvent[]) => events.map(item => item.seq)

describe('OrderedConsumer', () => {
  it('hands events over in seq order however they arrive', () => {
    const consumer = new OrderedConsumer()

    expect(seqs(consumer.accept(event(3)))).toEqual([])
    expect(seqs(consumer.accept(event(2)))).toEqual([])
    expect(consumer.pending('s1')).toEqual([2, 3])
    expect(seqs(consumer.accept(event(1)))).toEqual([1, 2, 3])
    expect(consumer.pending('s1')).toEqual([])
  })

  it('does not handle a delivery twice, and says it is a repeat', () => {
    const consumer = new OrderedConsumer()
    consumer.accept(event(1))

    expect(consumer.isRepeat('d1')).toBe(true)
    expect(consumer.accept(event(1))).toEqual([])
    expect(consumer.accept(event(1, 'another-delivery'))).toEqual([])
  })

  it('keeps a session apart from another', () => {
    const consumer = new OrderedConsumer()

    expect(seqs(consumer.accept(event(1, 'a', 's1')))).toEqual([1])
    expect(seqs(consumer.accept(event(1, 'b', 's2')))).toEqual([1])
    expect(seqs(consumer.accept(event(3, 'c', 's2')))).toEqual([])
    expect(seqs(consumer.accept(event(2, 'd', 's1')))).toEqual([2])
  })

  it('lets a ping through at once, outside the sequence', () => {
    const consumer = new OrderedConsumer()

    expect(seqs(consumer.accept({ ...event(0), event: 'ping' }))).toEqual([0])
    expect(seqs(consumer.accept(event(1)))).toEqual([1])
  })

  it('starts at the first event that arrives when told so', () => {
    const consumer = new OrderedConsumer('first-seen')

    expect(seqs(consumer.accept(event(57)))).toEqual([57])
    expect(seqs(consumer.accept(event(59)))).toEqual([])
    expect(seqs(consumer.accept(event(58)))).toEqual([58, 59])
  })

  // A webhook with a filter never sees the seq of the events it did not ask for
  it('does not wait for gaps when it is not ordered, and still drops repeats', () => {
    const consumer = new OrderedConsumer(1, false)

    expect(seqs(consumer.accept(event(5)))).toEqual([5])
    expect(seqs(consumer.accept(event(9)))).toEqual([9])
    expect(consumer.accept(event(9))).toEqual([])
  })

  it('can start from a seq other than 1', () => {
    const consumer = new OrderedConsumer(40)

    expect(seqs(consumer.accept(event(40)))).toEqual([40])
  })
})

describe('WebhookReceiver', () => {
  const sign = (body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) => ({
    'x-gateway-timestamp': String(timestamp),
    'x-gateway-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
  })
  const envelope = (seq: number) =>
    JSON.stringify({ id: `evt_${seq}`, event: 'message', sessionId: 's1', seq, data: {} })
  let receiver: WebhookReceiver
  const post = async (body: string, extra: Record<string, string>): Promise<number> =>
    (await fetch(receiver.address, { method: 'POST', body, headers: extra })).status

  beforeEach(async () => {
    receiver = new WebhookReceiver({ secret: SECRET })
    await receiver.start()
  })
  afterEach(() => receiver.stop())

  it('answers 200 to a valid delivery and hands it over', async () => {
    const body = envelope(1)

    expect(await post(body, { ...sign(body), 'x-gateway-delivery': 'd1' })).toBe(200)

    expect(receiver.handled.map(item => item.seq)).toEqual([1])
  })

  it('answers 401 to a signature of another secret and handles nothing', async () => {
    const body = envelope(1)

    expect(await post(body, { ...sign(body, 'whsec_other'), 'x-gateway-delivery': 'd1' })).toBe(401)

    expect(receiver.handled).toEqual([])
    expect(receiver.rejected).toHaveLength(1)
  })

  it('answers 200 to a repeat and handles it once', async () => {
    const body = envelope(1)
    const headers = { ...sign(body), 'x-gateway-delivery': 'd1' }

    expect(await post(body, headers)).toBe(200)
    expect(await post(body, headers)).toBe(200)

    expect(receiver.handled).toHaveLength(1)
  })

  it('holds an event until the ones before it arrive', async () => {
    const second = envelope(2)
    await post(second, { ...sign(second), 'x-gateway-delivery': 'd2' })
    expect(receiver.handled).toEqual([])
    expect(receiver.pending('s1')).toEqual([2])

    const first = envelope(1)
    await post(first, { ...sign(first), 'x-gateway-delivery': 'd1' })

    expect(receiver.handled.map(item => item.seq)).toEqual([1, 2])
  })

  it('answers the failures it was told to, after verifying, and then recovers', async () => {
    const body = envelope(1)
    const headers = { ...sign(body), 'x-gateway-delivery': 'd1' }
    receiver.failNext(503, 500)

    expect([
      await post(body, headers),
      await post(body, headers),
      await post(body, headers)
    ]).toEqual([503, 500, 200])
    expect(receiver.handled).toHaveLength(1)
  })

  it('answers 400 to a body that is not an event', async () => {
    const body = 'not json'

    expect(await post(body, { ...sign(body), 'x-gateway-delivery': 'd1' })).toBe(400)
  })

  it('follows a rotated secret', async () => {
    const body = envelope(1)
    receiver.secret = 'whsec_rotated'

    expect(await post(body, { ...sign(body), 'x-gateway-delivery': 'd1' })).toBe(401)
    expect(await post(body, { ...sign(body, 'whsec_rotated'), 'x-gateway-delivery': 'd1' })).toBe(
      200
    )
  })
})
