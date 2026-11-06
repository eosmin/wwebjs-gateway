import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { PrismaService } from '../../src/database/prisma.service.js'
import type { DeliveriesRepository } from '../../src/database/repositories/deliveries.repository.js'
import type { MessageDto } from '../../src/types/dto.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import {
  FakeWhatsAppClientFactory,
  type FakeWhatsAppClient,
  buildMessageDto
} from '../helpers/fake-whatsapp-client.js'
import { WebhookReceiver } from '../helpers/webhook-receiver.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const LOOPBACK = '127.0.0.1'
const CHAT = '5215500000001@c.us'
const MAX_ATTEMPTS = 3
const INLINE_MAX = 64

// A session, a webhook and the retries of a delivery take a few round trips each
jest.setTimeout(30_000)

interface Delivery {
  id: string
  event: string
  seq: string | number
  status: string
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
}

// Step 7.6: every scenario of TDD §7 Phase 7, over the whole application with real Postgres, Redis
// and BullMQ, and a receiver written from the documentation (`tests/helpers/webhook-receiver.ts`).
// The events come out of a fake WhatsApp client, through the real event pipeline.
describe('outbound webhooks (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const suffix = randomUUID().slice(0, 8)
  let app: NestFastifyApplication | undefined
  let deliveries: DeliveriesRepository | undefined
  let prisma: PrismaService | undefined
  const receivers: WebhookReceiver[] = []
  const webhookIds: string[] = []
  const sessionIds: string[] = []
  let counter = 0
  // The seq the next event of a session will get (the pipeline INCRs `seq:<session>`)
  let nextSeqOf: ((session: string) => Promise<number>) | undefined

  const get = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('the application did not boot')
    return value
  }
  const call = async (
    method: 'POST' | 'GET' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown
  ) => get(app).inject({ method, url, headers: ADMIN, payload: payload as never })
  const until = async <T>(read: () => Promise<T | undefined> | T | undefined, what: string) => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const value = await read()
      if (value !== undefined) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  // A session that is ready, with the client the application built for it
  async function newSession(): Promise<{ id: string; client: FakeWhatsAppClient }> {
    counter += 1
    const id = `wh-e2e-${suffix}-${counter}`
    expect((await call('POST', '/v1/sessions', { id })).statusCode).toBe(201)
    sessionIds.push(id)
    expect((await call('POST', `/v1/sessions/${id}/start`)).statusCode).toBe(200)
    const client = get(factory.clientFor(id))
    client.emit({ event: 'ready', data: {} })
    await until(async () => {
      const status = (await call('GET', `/v1/sessions/${id}`)).json<{ status: string }>().status
      return status === 'ready' ? true : undefined
    }, 'the session to be ready')
    return { id, client }
  }

  // A receiver and a webhook that points at it. A receiver of a webhook with a filter cannot wait
  // for the events before the one it got (their `seq` are not for it), so it only drops repeats;
  // one that takes every event (`*`) orders by `seq` from the first `seq` the session will assign.
  // It is not "the first event that arrives": the deliveries of a burst reach the receiver in any
  // order, and a receiver that began at the one that came first would drop the ones before it.
  async function hook(
    session: string,
    body: Record<string, unknown> = {},
    // A test of what a webhook gets, not of how a receiver orders it, takes the events as they come
    options: { ordered?: boolean } = {}
  ): Promise<{ id: string; receiver: WebhookReceiver }> {
    const everything = (body['events'] as string[] | undefined)?.includes('*') ?? false
    const receiver = new WebhookReceiver({
      secret: 'pending',
      ordered: everything && options.ordered !== false,
      firstSeq: everything && options.ordered !== false ? await get(nextSeqOf)(session) : 1
    })
    receivers.push(receiver)
    const address = await receiver.start()
    const response = await call('POST', '/v1/webhooks', {
      url: `${address}/hook`,
      sessionId: session,
      ...body
    })
    expect(response.statusCode).toBe(201)
    const created = response.json<{ id: string; secret: string }>()
    receiver.secret = created.secret
    webhookIds.push(created.id)
    return { id: created.id, receiver }
  }

  const incoming = (id: string, over: Partial<MessageDto> = {}): MessageDto =>
    buildMessageDto({
      id,
      chatId: CHAT,
      from: CHAT,
      fromMe: false,
      body: `text of ${id}`,
      sentAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      ...over
    })

  const rowsOf = async (webhookId: string): Promise<Delivery[]> =>
    (await call('GET', `/v1/webhooks/${webhookId}/deliveries?limit=200`)).json<{
      items: Delivery[]
    }>().items
  const settled = (webhookId: string, status: string, count = 1) =>
    until(async () => {
      const rows = (await rowsOf(webhookId)).filter(row => row.status === status)
      return rows.length >= count ? rows : undefined
    }, `${count} ${status} deliveries`)
  const handledEvents = (receiver: WebhookReceiver) =>
    until(() => (receiver.handled.length > 0 ? receiver.handled : undefined), 'a delivery')
  const names = (receiver: WebhookReceiver): string[] => receiver.handled.map(item => item.event)

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    setEnv({
      DATABASE_URL,
      REDIS_URL,
      RATE_LIMIT_MAX: '100000',
      // Every scenario has a session of its own
      MAX_SESSIONS: '200',
      WEBHOOK_PRIVATE_HOST_ALLOWLIST: LOOPBACK,
      WEBHOOK_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
      WEBHOOK_BACKOFF_MS: '50',
      WEBHOOK_TIMEOUT_MS: '3000',
      WEBHOOK_INLINE_MEDIA_MAX_BYTES: String(INLINE_MAX),
      INBOUND_ORDER_WINDOW_MS: '300',
      INBOUND_ORDER_MAX_HOLD_MS: '1500'
    })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { DeliveriesRepository } =
      await import('../../src/database/repositories/deliveries.repository.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { PrismaService } = await import('../../src/database/prisma.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')
    const { Queue } = await import('bullmq')
    const { DELIVERY_QUEUE_NAME } = await import('../../src/services/delivery-queue.service.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    const redis = app.get(RedisService)
    nextSeqOf = async session => Number((await redis.client.get(`seq:${session}`)) ?? 0) + 1
    deliveries = app.get(DeliveriesRepository)
    prisma = app.get(PrismaService)
    // Another suite may have left the queue paused
    const queue = new Queue(DELIVERY_QUEUE_NAME, { connection: redis.client })
    await queue.resume()
    await queue.close()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    for (const id of webhookIds.splice(0)) await call('DELETE', `/v1/webhooks/${id}`)
    await Promise.all(receivers.splice(0).map(receiver => receiver.stop()))
  })

  afterAll(async () => {
    try {
      const { SessionsRepository } =
        await import('../../src/database/repositories/sessions.repository.js')
      // The webhooks and their deliveries go with the session (cascade)
      for (const id of sessionIds) await get(app).get(SessionsRepository).delete(id)
    } finally {
      await app?.close()
    }
  })

  describe('signature', () => {
    it('is valid for a receiver written from the documentation, over the raw bytes', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'] })

      client.emit({ event: 'message', data: incoming('m1') })

      const [event] = await handledEvents(receiver)
      expect(event).toMatchObject({ event: 'message', sessionId: session, data: { id: 'm1' } })
      expect(receiver.rejected).toEqual([])
      const headers = receiver.requests[0]?.headers
      expect(headers?.['x-gateway-event']).toBe('message')
      expect(headers?.['x-gateway-delivery']).toBe(event?.deliveryId)
      expect(headers?.['user-agent']).toMatch(/^wwebjs-gateway\//)
      expect((await settled(id, 'success'))[0]).toMatchObject({ attempts: 1, lastStatusCode: 200 })
    })

    it('is refused by a receiver that holds another secret, and the delivery ends among the dead letters', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'] })
      receiver.secret = 'whsec_not_the_one'

      client.emit({ event: 'message', data: incoming('m1') })

      const [dead] = await settled(id, 'failed')
      expect(dead).toMatchObject({ attempts: MAX_ATTEMPTS, lastStatusCode: 401 })
      expect(receiver.handled).toEqual([])
      expect(receiver.rejected.map(item => item.reason)).toEqual(
        Array(MAX_ATTEMPTS).fill('signature does not match')
      )
    })

    it('follows a rotated secret, also for what was waiting for a retry', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'] })
      receiver.failNext(503)

      client.emit({ event: 'message', data: incoming('m1') })
      await until(() => (receiver.requests.length >= 1 ? true : undefined), 'the first attempt')
      const rotated = (await call('POST', `/v1/webhooks/${id}/rotate-secret`)).json<{
        secret: string
      }>()
      receiver.secret = rotated.secret

      await settled(id, 'success')
      expect(receiver.handled.map(item => item.data)).toEqual([
        expect.objectContaining({ id: 'm1' })
      ])
    })
  })

  describe('retry', () => {
    it('retries a receiver that fails, as the same delivery, until it answers', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'] })
      receiver.failNext(503, 500)

      client.emit({ event: 'message', data: incoming('m1') })

      const [row] = await settled(id, 'success')
      expect(row?.attempts).toBe(3)
      expect(receiver.requests).toHaveLength(3)
      expect(
        new Set(receiver.requests.map(request => request.headers['x-gateway-delivery'])).size
      ).toBe(1)
      // Each attempt is signed at its own time, over the same bytes
      expect(new Set(receiver.requests.map(request => request.body)).size).toBe(1)
      expect(receiver.handled).toHaveLength(1)
    })

    it('leaves the delivery among the dead letters after the last attempt, and a retry recovers it', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'] })
      receiver.failNext(500, 500, 500)

      client.emit({ event: 'message', data: incoming('m1') })

      const [dead] = await settled(id, 'failed')
      expect(dead).toMatchObject({
        attempts: MAX_ATTEMPTS,
        lastStatusCode: 500,
        lastError: 'The receiver answered 500'
      })
      expect(receiver.handled).toEqual([])

      const retried = await call('POST', `/v1/webhooks/${id}/deliveries/${dead?.id}/retry`)
      expect(retried.statusCode).toBe(202)
      await settled(id, 'success')
      expect(receiver.handled).toHaveLength(1)
    })

    it('retries every dead letter of a webhook at once', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'] })
      receiver.failNext(...Array<number>(2 * MAX_ATTEMPTS).fill(500))

      client.emit({
        event: 'message',
        data: incoming('a', { sentAt: new Date(Date.now() - 30_000).toISOString() })
      })
      client.emit({
        event: 'message',
        data: incoming('b', { sentAt: new Date(Date.now() - 10_000).toISOString() })
      })
      await settled(id, 'failed', 2)

      const response = await call('POST', `/v1/webhooks/${id}/deliveries/retry-failed`)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ retried: 2, more: false })
      await settled(id, 'success', 2)
      // Newest first is how the dead letters are listed; the order of the receiver is the next test
      expect(receiver.handled.map(item => (item.data as { id: string }).id).sort()).toEqual([
        'a',
        'b'
      ])
    })

    it('hands events to the receiver in seq order although the retries reach it out of order', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['*'] })
      // A first event, so the receiver knows where the sequence starts
      client.emit({ event: 'message', data: incoming('warm-up') })
      await handledEvents(receiver)
      const before = receiver.handled.length
      // The next event fails once, so the ones after it arrive before it
      receiver.failNext(503)

      client.emit({
        event: 'message',
        data: incoming('a', { sentAt: new Date(Date.now() - 30_000).toISOString() })
      })
      client.emit({
        event: 'message',
        data: incoming('b', { sentAt: new Date(Date.now() - 10_000).toISOString() })
      })

      await until(() => (receiver.handled.length >= before + 3 ? true : undefined), 'three events')
      const fresh = receiver.handled.slice(before)
      expect(fresh.map(item => item.event)).toEqual(['message', 'message', 'message_batch'])
      expect(fresh.map(item => item.seq)).toEqual(
        [...fresh.map(item => item.seq)].sort((x, y) => x - y)
      )
      expect(receiver.pending(session)).toEqual([])
      // The failed attempt really happened, and the delivery still ended well
      expect(receiver.requests.length).toBeGreaterThan(receiver.handled.length)
      expect(
        (await rowsOf(id)).every(row => row.status === 'success' || row.status === 'pending')
      ).toBe(true)
    })
  })

  describe('who gets what', () => {
    it('sends nothing to a disabled webhook, and an enabled one takes the next event', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'], enabled: false })

      client.emit({ event: 'message', data: incoming('m1') })
      await new Promise(resolve => setTimeout(resolve, 1200))
      expect(receiver.requests).toEqual([])
      expect(await rowsOf(id)).toEqual([])

      expect((await call('PATCH', `/v1/webhooks/${id}`, { enabled: true })).statusCode).toBe(200)
      client.emit({ event: 'message', data: incoming('m2') })

      await settled(id, 'success')
      expect(receiver.handled.map(item => (item.data as { id: string }).id)).toEqual(['m2'])
    })

    it('filters by event, and "*" takes everything', async () => {
      const { id: session, client } = await newSession()
      const messages = await hook(session, { events: ['message'] })
      const batches = await hook(session, { events: ['message_batch'] })
      // The three deliveries of the burst reach any receiver in any order: this one keeps them as they
      // come and the test puts them in the order of the gateway (`seq`)
      const all = await hook(session, { events: ['*'] }, { ordered: false })

      client.emit({
        event: 'message',
        data: incoming('a', { sentAt: new Date(Date.now() - 30_000).toISOString() })
      })
      client.emit({
        event: 'message',
        data: incoming('b', { sentAt: new Date(Date.now() - 10_000).toISOString() })
      })

      await until(() => (all.receiver.handled.length >= 3 ? true : undefined), 'three events')
      expect(names(messages.receiver)).toEqual(['message', 'message'])
      expect(names(batches.receiver)).toEqual(['message_batch'])
      const bySeq = [...all.receiver.handled].sort((x, y) => x.seq - y.seq)
      expect(bySeq.map(item => item.event)).toEqual(['message', 'message', 'message_batch'])
      expect(new Set(bySeq.map(item => item.seq)).size).toBe(3)
    })

    it('delivers the message_batch that the gateway synthesizes, with the messages in conversation order', async () => {
      const { id: session, client } = await newSession()
      const { receiver } = await hook(session, { events: ['message_batch'] })

      client.emit({
        event: 'message',
        data: incoming('late', { sentAt: new Date(Date.now() - 10_000).toISOString() })
      })
      client.emit({
        event: 'message',
        data: incoming('early', { sentAt: new Date(Date.now() - 30_000).toISOString() })
      })

      const [batch] = await handledEvents(receiver)
      const { messages } = batch?.data as { messages: { id: string }[] }
      expect(messages.map(message => message.id)).toEqual(['early', 'late'])
    })

    it('reaches a receiver on a private address only because the allowlist names it', async () => {
      const { id: session } = await newSession()
      const { receiver } = await hook(session)
      expect(receiver.address).toContain(LOOPBACK)

      // Another loopback address is private too, and nobody allowed it
      const refused = await call('POST', '/v1/webhooks', {
        url: `http://127.0.0.2:${new URL(receiver.address).port}/hook`,
        sessionId: session
      })

      expect(refused.statusCode).toBe(400)
    })
  })

  describe('what the event carries', () => {
    it('keeps the QR out of the stored copy and sends the real one', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['qr'] })

      client.emit({ event: 'qr', data: { qr: '2@secretqrvalue' } })

      const [event] = await handledEvents(receiver)
      expect(event?.data).toEqual({ qr: '2@secretqrvalue' })
      const [row] = await settled(id, 'success')
      const stored = await get(deliveries).findById(row?.id ?? '')
      expect(JSON.stringify(stored?.payload)).not.toContain('secretqrvalue')
      expect(stored?.payload).toMatchObject({ data: { qr: '[Redacted]' } })
      // The stored copy has nothing left to send, so a retry by hand is refused
      const retried = await call('POST', `/v1/webhooks/${id}/deliveries/${row?.id}/retry`)
      expect(retried.statusCode).toBe(400)
    })

    describe('media', () => {
      const photo = (size = 4): Partial<MessageDto> => ({
        hasMedia: true,
        type: 'image',
        media: {
          mimetype: 'image/png',
          filename: 'a.png',
          size,
          downloadUrl: 'https://gw.example/m'
        }
      })
      const bytes = Buffer.from('abc').toString('base64')

      it('follows the mediaMode of each webhook', async () => {
        const { id: session, client } = await newSession()
        client.script('downloadMedia', () => ({ mimetype: 'image/png', data: bytes }))
        const none = await hook(session, { events: ['message'], mediaMode: 'none' })
        const reference = await hook(session, { events: ['message'], mediaMode: 'reference' })
        const inline = await hook(session, { events: ['message'], mediaMode: 'inline' })

        client.emit({ event: 'message', data: incoming('m1', photo()) })

        const [byNone] = await handledEvents(none.receiver)
        const [byReference] = await handledEvents(reference.receiver)
        const [byInline] = await handledEvents(inline.receiver)
        expect(byNone?.data).not.toHaveProperty('media')
        expect(byReference?.data).toMatchObject({
          media: { mimetype: 'image/png', size: 4, downloadUrl: 'https://gw.example/m' }
        })
        expect(byReference?.data).not.toHaveProperty('media.base64')
        expect(byInline?.data).toMatchObject({ media: { base64: bytes } })
        // The file was downloaded once for the event, not once per webhook
        expect(client.callsOf('downloadMedia')).toHaveLength(1)
      })

      it('keeps the bytes out of the table, so a retry by hand sends the reference only', async () => {
        const { id: session, client } = await newSession()
        client.script('downloadMedia', () => ({ mimetype: 'image/png', data: bytes }))
        const { id, receiver } = await hook(session, { events: ['message'], mediaMode: 'inline' })

        client.emit({ event: 'message', data: incoming('m1', photo()) })

        const [row] = await settled(id, 'success')
        expect(receiver.requests[0]?.body).toContain(bytes)
        const stored = await get(deliveries).findById(row?.id ?? '')
        expect(JSON.stringify(stored?.payload)).not.toContain(bytes)
        expect(stored?.payload).toMatchObject({
          data: { media: { downloadUrl: 'https://gw.example/m' } }
        })
        // A delivery that was made is never sent again: it has to be a dead letter to be retried
        await get(prisma).webhookDelivery.update({
          where: { id: row?.id ?? '' },
          data: { status: 'failed' }
        })
        expect(
          (await call('POST', `/v1/webhooks/${id}/deliveries/${row?.id}/retry`)).statusCode
        ).toBe(202)
        await until(() => (receiver.requests.length >= 2 ? true : undefined), 'the retry')
        expect(receiver.requests[1]?.body).not.toContain(bytes)
        expect(receiver.requests[1]?.body).toContain('https://gw.example/m')
      })

      it('sends a file past the limit by reference only, without downloading it', async () => {
        const { id: session, client } = await newSession()
        const { receiver } = await hook(session, { events: ['message'], mediaMode: 'inline' })

        client.emit({ event: 'message', data: incoming('m1', photo(INLINE_MAX + 1)) })

        const [event] = await handledEvents(receiver)
        expect(event?.data).toMatchObject({ media: { size: INLINE_MAX + 1 } })
        expect(event?.data).not.toHaveProperty('media.base64')
        expect(client.callsOf('downloadMedia')).toHaveLength(0)
      })

      it('still sends the event, by reference, when WhatsApp no longer has the file', async () => {
        const { id: session, client } = await newSession()
        client.script('downloadMedia', () => null)
        const { receiver } = await hook(session, { events: ['message'], mediaMode: 'inline' })

        client.emit({ event: 'message', data: incoming('m1', photo()) })

        const [event] = await handledEvents(receiver)
        expect(event?.data).toMatchObject({ media: { downloadUrl: 'https://gw.example/m' } })
        expect(event?.data).not.toHaveProperty('media.base64')
      })
    })

    describe('raw data', () => {
      it('goes to the webhooks that include it and not to the others', async () => {
        const { id: session, client } = await newSession()
        const yes = await hook(session, { events: ['message'], includeRaw: true })
        const no = await hook(session, { events: ['message'], includeRaw: false })
        const follows = await hook(session, { events: ['message'] })

        client.emit({
          event: 'message',
          data: incoming('m1', { raw: { internal: 'value' } })
        })

        const [withRaw] = await handledEvents(yes.receiver)
        const [withoutRaw] = await handledEvents(no.receiver)
        const [byDefault] = await handledEvents(follows.receiver)
        expect(withRaw?.data).toMatchObject({ raw: { internal: 'value' } })
        expect(withoutRaw?.data).not.toHaveProperty('raw')
        // INCLUDE_RAW is on in this suite
        expect(byDefault?.data).toMatchObject({ raw: { internal: 'value' } })
      })
    })
  })

  describe('failures of the gateway itself', () => {
    it('still queues the event when the delivery cannot be stored', async () => {
      const { id: session, client } = await newSession()
      const { id, receiver } = await hook(session, { events: ['message'] })
      jest.spyOn(get(deliveries), 'create').mockRejectedValue(new Error('database down'))

      client.emit({ event: 'message', data: incoming('m1') })

      const [event] = await handledEvents(receiver)
      expect(event?.data).toMatchObject({ id: 'm1' })
      // The log is down, so there is no row for it
      expect(await rowsOf(id)).toEqual([])
      const metrics = await call('GET', '/metrics')
      expect(metrics.body).toMatch(/gw_webhook_deliveries_total\{result="unlogged"\} [1-9]/)
    })
  })
})
