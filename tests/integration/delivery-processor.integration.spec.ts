import { randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'

import type { DeliveriesRepository } from '../../src/database/repositories/deliveries.repository.js'
import type { DeliveryQueueService } from '../../src/services/delivery-queue.service.js'
import type { EventEnvelope } from '../../src/types/events.js'
import type { EventBusService } from '../../src/whatsapp/event-bus.service.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import { FakeWhatsAppClientFactory } from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const LOOPBACK = '127.0.0.1'
const MAX_ATTEMPTS = 3

interface Received {
  headers: IncomingHttpHeaders
  body: string
}

// Step 7.4 over the whole application with real Postgres, Redis and BullMQ: an event published on the
// bus is delivered by the processor to a receiver of this suite, signed, retried when the receiver
// fails and left among the dead letters when it keeps failing.
describe('delivery processor (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const suffix = randomUUID().slice(0, 8)
  const session = `wh-prc-${suffix}`
  let app: NestFastifyApplication | undefined
  let bus: EventBusService | undefined
  let deliveries: DeliveriesRepository | undefined
  let queueService: DeliveryQueueService | undefined
  let queue: Queue | undefined
  let server: Server
  let port = 0
  let received: Received[] = []
  // What the receiver does with the request number `index` (0-based), possibly asynchronously
  let handle: (index: number) => Promise<number> = () => Promise.resolve(200)
  let seq = 0
  const created: string[] = []

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const call = async (method: 'POST' | 'GET' | 'DELETE', url: string, payload?: unknown) =>
    application().inject({ method, url, headers: ADMIN, payload: payload as never })
  const createWebhook = async (): Promise<{ id: string; secret: string }> => {
    const response = await call('POST', '/v1/webhooks', {
      url: `http://${LOOPBACK}:${port}/hook/${suffix}`,
      sessionId: session,
      events: ['message', 'qr']
    })
    expect(response.statusCode).toBe(201)
    const webhook = response.json<{ id: string; secret: string }>()
    created.push(webhook.id)
    return webhook
  }
  const publish = (event: string, data: unknown): number => {
    seq += 1
    bus?.publish({
      id: `evt_${randomUUID()}`,
      event,
      sessionId: session,
      seq,
      timestamp: '2026-01-01T00:00:00.000Z',
      data
    } as unknown as EventEnvelope)
    return seq
  }
  const until = async <T>(read: () => Promise<T | undefined>, what: string): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await read()
      if (value !== undefined) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const deliveryOf = async (webhookId: string, status: string, count = 1) =>
    until(async () => {
      const rows = (await deliveries?.listForWebhook(webhookId, { limit: 50 })) ?? []
      const match = rows.filter(row => row.status === status)
      return match.length >= count ? match : undefined
    }, `${count} ${status} delivery(ies)`)
  const signatureOf = async (secret: string, request: Received): Promise<string> => {
    const { signWebhook } = await import('../../src/common/lib/crypto.js')
    return signWebhook(secret, Number(request.headers['x-gateway-timestamp']), request.body)
  }

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
        handle(received.length - 1).then(
          status => {
            response.statusCode = status
            response.end()
          },
          () => {
            response.statusCode = 500
            response.end()
          }
        )
      })
    })
    await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
    port = (server.address() as AddressInfo).port

    setEnv({
      DATABASE_URL,
      REDIS_URL,
      RATE_LIMIT_MAX: '100000',
      WEBHOOK_PRIVATE_HOST_ALLOWLIST: LOOPBACK,
      WEBHOOK_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
      WEBHOOK_BACKOFF_MS: '50',
      WEBHOOK_TIMEOUT_MS: '3000'
    })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { DeliveriesRepository } =
      await import('../../src/database/repositories/deliveries.repository.js')
    const { EventBusService } = await import('../../src/whatsapp/event-bus.service.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')
    const { DELIVERY_QUEUE_NAME, DeliveryQueueService } =
      await import('../../src/services/delivery-queue.service.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    bus = app.get(EventBusService)
    deliveries = app.get(DeliveriesRepository)
    queueService = app.get(DeliveryQueueService)
    queue = new Queue(DELIVERY_QUEUE_NAME, { connection: app.get(RedisService).client })
    // Another suite may have left the queue paused
    await queue.resume()
    expect((await call('POST', '/v1/sessions', { id: session })).statusCode).toBe(201)
  })

  beforeEach(() => {
    received = []
    handle = () => Promise.resolve(200)
  })

  // A webhook left behind would receive the events of the tests that follow
  afterEach(async () => {
    for (const id of created.splice(0)) await call('DELETE', `/v1/webhooks/${id}`)
  })

  afterAll(async () => {
    try {
      const { SessionsRepository } =
        await import('../../src/database/repositories/sessions.repository.js')
      // The webhooks and their deliveries go with the session (cascade)
      await application().get(SessionsRepository).delete(session)
    } finally {
      await queue?.close()
      await app?.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('delivers an event signed, and records the delivery as a success', async () => {
    const { id, secret } = await createWebhook()
    const sent = publish('message', { id: 'm1', body: 'hello' })

    const [row] = await deliveryOf(id, 'success')

    expect(row).toMatchObject({ attempts: 1, lastStatusCode: 200, lastError: null })
    expect(row?.deliveredAt).toBeInstanceOf(Date)
    expect(received).toHaveLength(1)
    const request = received[0] as Received
    expect(request.headers['x-gateway-delivery']).toBe(row?.id)
    expect(request.headers['x-gateway-event']).toBe('message')
    expect(request.headers['x-gateway-seq']).toBe(String(sent))
    expect(request.headers['x-gateway-signature']).toBe(await signatureOf(secret, request))
    expect(JSON.parse(request.body)).toMatchObject({
      event: 'message',
      seq: sent,
      data: { id: 'm1' }
    })
  })

  it('retries a receiver that fails, always as the same delivery, until it answers', async () => {
    handle = index => Promise.resolve(index < 2 ? 503 : 200)
    const { id } = await createWebhook()
    publish('message', { id: 'm2' })

    const [row] = await deliveryOf(id, 'success')

    expect(row?.attempts).toBe(3)
    expect(received).toHaveLength(3)
    expect(new Set(received.map(request => request.headers['x-gateway-delivery'])).size).toBe(1)
    expect(new Set(received.map(request => request.body)).size).toBe(1)
  })

  it('leaves the delivery among the dead letters when every attempt fails, and a retry can recover it', async () => {
    handle = () => Promise.resolve(500)
    const { id } = await createWebhook()
    publish('message', { id: 'm3' })

    const [dead] = await deliveryOf(id, 'failed')

    expect(dead).toMatchObject({
      attempts: MAX_ATTEMPTS,
      lastStatusCode: 500,
      lastError: 'The receiver answered 500'
    })
    expect(received).toHaveLength(MAX_ATTEMPTS)

    handle = () => Promise.resolve(200)
    const retried = await call('POST', `/v1/webhooks/${id}/deliveries/${dead?.id}/retry`)
    expect(retried.statusCode).toBe(202)
    const [recovered] = await deliveryOf(id, 'success')
    expect(recovered).toMatchObject({ id: dead?.id, attempts: MAX_ATTEMPTS + 1 })
  })

  it('signs a retry with the secret the webhook has when the attempt runs', async () => {
    const { id, secret } = await createWebhook()
    // The first answer is held until the secret is rotated, so the retry is the first to see it
    let rotated = secret
    handle = async index => {
      if (index > 0) return 200
      const response = await call('POST', `/v1/webhooks/${id}/rotate-secret`)
      rotated = response.json<{ secret: string }>().secret
      return 500
    }
    publish('message', { id: 'm4' })

    await deliveryOf(id, 'success')

    const [first, second] = received as [Received, Received]
    expect(rotated).not.toBe(secret)
    expect(first.headers['x-gateway-signature']).toBe(await signatureOf(secret, first))
    expect(second.headers['x-gateway-signature']).toBe(await signatureOf(rotated, second))
  })

  it('delivers a job whose row was never stored, and drops the job of a webhook that is gone', async () => {
    const { id } = await createWebhook()
    const envelope = {
      id: `evt_${randomUUID()}`,
      event: 'message',
      sessionId: session,
      seq: 99,
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { id: 'no-row' }
    }
    const orphan = randomUUID()
    await queueService?.enqueue({ deliveryId: orphan, webhookId: id, envelope })

    await until(() => Promise.resolve(received.length > 0 ? true : undefined), 'the delivery')
    expect(received[0]?.headers['x-gateway-delivery']).toBe(orphan)
    expect(await deliveries?.findById(orphan)).toBeNull()

    received = []
    const gone = randomUUID()
    await queueService?.enqueue({ deliveryId: gone, webhookId: randomUUID(), envelope })
    const job = await until(async () => {
      const done = await queue?.getJobs(['completed'])
      return done?.find(
        candidate => (candidate.data as { deliveryId?: string }).deliveryId === gone
      )
    }, 'the job of the missing webhook to complete')
    expect(await job.getState()).toBe('completed')
    expect(received).toHaveLength(0)
  })

  it('never sends the real credential of a qr again from the stored copy', async () => {
    handle = () => Promise.resolve(500)
    const { id } = await createWebhook()
    publish('qr', { qr: '2@real-qr-payload' })
    const [dead] = await deliveryOf(id, 'failed')
    // The automatic attempts carried the real QR; the stored copy is redacted
    expect(received.every(request => request.body.includes('2@real-qr-payload'))).toBe(true)
    expect(JSON.stringify(dead?.payload)).not.toContain('real-qr-payload')

    received = []
    const retried = await call('POST', `/v1/webhooks/${id}/deliveries/${dead?.id}/retry`)

    expect(retried.statusCode).toBe(400)
    expect(received).toHaveLength(0)
  })
})
