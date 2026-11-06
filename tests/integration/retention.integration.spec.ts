import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'

import type { PrismaService } from '../../src/database/prisma.service.js'
import type { DeliveriesRepository } from '../../src/database/repositories/deliveries.repository.js'
import type { IdempotencyRepository } from '../../src/database/repositories/idempotency.repository.js'
import type { MessagesRepository } from '../../src/database/repositories/messages.repository.js'
import type { DeliveryQueueService } from '../../src/services/delivery-queue.service.js'
import type { RetentionService } from '../../src/services/retention.service.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import { FakeWhatsAppClientFactory } from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const LOOPBACK = '127.0.0.1'
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// Step 7.5 over the whole application with real Postgres, Redis and BullMQ: what the retention job
// deletes, the schedules it registers, and the sweep of pending deliveries that lost their job.
describe('retention (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const suffix = randomUUID().slice(0, 8)
  const session = `retention-${suffix}`
  let app: NestFastifyApplication | undefined
  let retention: RetentionService | undefined
  let prisma: PrismaService | undefined
  let deliveries: DeliveriesRepository | undefined
  let queueService: DeliveryQueueService | undefined
  let queue: Queue | undefined
  let server: Server
  let port = 0
  let received: string[] = []
  let answer = 200
  let webhookId = ''
  const created: string[] = []

  const get = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('the application did not boot')
    return value
  }
  const call = async (method: 'POST' | 'GET' | 'DELETE', url: string, payload?: unknown) =>
    get(app).inject({ method, url, headers: ADMIN, payload: payload as never })
  const until = async <T>(read: () => Promise<T | undefined>, what: string): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await read()
      if (value !== undefined) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const envelope = (seq: number) => ({
    id: `evt_${randomUUID()}`,
    event: 'message',
    sessionId: session,
    seq,
    timestamp: '2026-01-01T00:00:00.000Z',
    data: { id: `m${seq}` }
  })
  // A pending row as the dispatcher stores it, `ago` milliseconds old
  const pendingRow = async (seq: number, ago: number) => {
    const row = await get(deliveries).create({
      webhookId,
      sessionId: session,
      event: 'message',
      seq: BigInt(seq),
      payload: envelope(seq)
    })
    created.push(row.id)
    await get(prisma).webhookDelivery.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - ago) }
    })
    return row
  }
  const statusOf = async (id: string) => get(deliveries).findById(id)
  const settled = async (id: string, status: string) =>
    until(async () => {
      const row = await statusOf(id)
      return row?.status === status ? row : undefined
    }, `delivery ${id} to be ${status}`)

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.push(String(request.headers['x-gateway-delivery']))
        response.statusCode = answer
        response.end()
      })
    })
    await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
    port = (server.address() as AddressInfo).port

    setEnv({
      DATABASE_URL,
      REDIS_URL,
      RATE_LIMIT_MAX: '100000',
      WEBHOOK_PRIVATE_HOST_ALLOWLIST: LOOPBACK,
      WEBHOOK_MAX_ATTEMPTS: '2',
      WEBHOOK_BACKOFF_MS: '50',
      WEBHOOK_TIMEOUT_MS: '3000'
    })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { PrismaService } = await import('../../src/database/prisma.service.js')
    const { DeliveriesRepository } =
      await import('../../src/database/repositories/deliveries.repository.js')
    const { RetentionService, RETENTION_QUEUE_NAME } =
      await import('../../src/services/retention.service.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')
    const { DELIVERY_QUEUE_NAME, DeliveryQueueService } =
      await import('../../src/services/delivery-queue.service.js')
    void RETENTION_QUEUE_NAME

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    retention = app.get(RetentionService)
    prisma = app.get(PrismaService)
    deliveries = app.get(DeliveriesRepository)
    queueService = app.get(DeliveryQueueService)
    queue = new Queue(DELIVERY_QUEUE_NAME, { connection: app.get(RedisService).client })
    // Another suite may have left the queue paused
    await queue.resume()
    expect((await call('POST', '/v1/sessions', { id: session })).statusCode).toBe(201)
    const webhook = await call('POST', '/v1/webhooks', {
      url: `http://${LOOPBACK}:${port}/hook/${suffix}`,
      sessionId: session,
      events: ['message']
    })
    expect(webhook.statusCode).toBe(201)
    webhookId = webhook.json<{ id: string }>().id
  })

  beforeEach(() => {
    received = []
    answer = 200
  })

  afterAll(async () => {
    try {
      await queue?.resume()
      const { SessionsRepository } =
        await import('../../src/database/repositories/sessions.repository.js')
      // The webhook and its deliveries go with the session (cascade)
      await get(app).get(SessionsRepository).delete(session)
    } finally {
      await queue?.close()
      await app?.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  describe('purge', () => {
    it('deletes what is past its retention and keeps the rest', async () => {
      const { IdempotencyRepository } =
        await import('../../src/database/repositories/idempotency.repository.js')
      const { MessagesRepository } =
        await import('../../src/database/repositories/messages.repository.js')
      const idempotency: IdempotencyRepository = get(app).get(IdempotencyRepository)
      const messages: MessagesRepository = get(app).get(MessagesRepository)
      const db = get(prisma)

      const oldDelivery = await pendingRow(1, 15 * DAY)
      const freshDelivery = await pendingRow(2, 13 * DAY)
      await idempotency.claim(session, 'old-key', 'hash')
      await idempotency.claim(session, 'fresh-key', 'hash')
      await db.idempotencyKey.update({
        where: { sessionId_key: { sessionId: session, key: 'old-key' } },
        data: { createdAt: new Date(Date.now() - DAY - MINUTE) }
      })
      const message = (id: string, receivedAt: Date) => ({
        id,
        sessionId: session,
        chatId: '5215500000000@c.us',
        direction: 'out' as const,
        fromMe: true,
        type: 'chat',
        body: null,
        hasMedia: false,
        ack: null,
        sentAt: receivedAt,
        receivedAt,
        dto: {}
      })
      await messages.upsert(message('old-message', new Date(Date.now() - 31 * DAY)))
      await messages.upsert(message('fresh-message', new Date(Date.now() - 29 * DAY)))

      const result = await get(retention).purgeExpired()

      expect(result.deliveries).toBeGreaterThanOrEqual(1)
      expect(result.idempotencyKeys).toBeGreaterThanOrEqual(1)
      expect(result.messages).toBeGreaterThanOrEqual(1)
      expect(await statusOf(oldDelivery.id)).toBeNull()
      expect(await statusOf(freshDelivery.id)).not.toBeNull()
      expect(await idempotency.find(session, 'old-key')).toBeNull()
      expect(await idempotency.find(session, 'fresh-key')).not.toBeNull()
      expect(await messages.findById(session, 'old-message')).toBeNull()
      expect(await messages.findById(session, 'fresh-message')).not.toBeNull()
    })

    it('registers the daily purge and the sweep once, however often the application starts', async () => {
      const probe = new Queue('retention', { connection: { url: REAL_ENV.REDIS_URL } as never })
      try {
        const schedulers = await probe.getJobSchedulers()

        const keys = schedulers.map(scheduler => scheduler.key)
        expect(keys.filter(key => key === 'purge')).toHaveLength(1)
        expect(keys.filter(key => key === 'sweep-pending')).toHaveLength(1)
        expect(schedulers.find(scheduler => scheduler.key === 'purge')?.pattern).toBe('0 3 * * *')
        expect(schedulers.find(scheduler => scheduler.key === 'sweep-pending')?.every).toBe(
          10 * MINUTE
        )
      } finally {
        await probe.close()
      }
    })
  })

  describe('sweep of pending deliveries', () => {
    // A crash between storing the row and queueing the job: nothing will ever run it
    it('sends a pending row without a job to the dead letters, and a retry delivers it', async () => {
      const row = await pendingRow(10, 45 * MINUTE)

      const result = await get(retention).sweepPending()

      expect(result.failed).toBeGreaterThanOrEqual(1)
      const swept = await statusOf(row.id)
      expect(swept?.status).toBe('failed')
      expect(swept?.lastError).toContain('no job in the queue')

      const retried = await call('POST', `/v1/webhooks/${webhookId}/deliveries/${row.id}/retry`)
      expect(retried.statusCode).toBe(202)
      await settled(row.id, 'success')
      expect(received).toEqual([row.id])
    })

    it('leaves a recent row alone, however it came to be pending', async () => {
      const row = await pendingRow(11, 5 * MINUTE)

      await get(retention).sweepPending()

      expect((await statusOf(row.id))?.status).toBe('pending')
    })

    // The receiver is down and the job waits for its next attempt: the row is old and pending, and
    // the job is alive
    it('leaves a row whose job is still going to run', async () => {
      const row = await pendingRow(12, 45 * MINUTE)
      await get(queue).pause()
      try {
        await get(queueService).enqueue({
          deliveryId: row.id,
          webhookId,
          envelope: envelope(12)
        })

        const result = await get(retention).sweepPending()

        expect(result.alive).toBeGreaterThanOrEqual(1)
        expect((await statusOf(row.id))?.status).toBe('pending')
      } finally {
        await get(queue).resume()
      }
      await settled(row.id, 'success')
    })

    // The receiver answered 2xx and the row could not be written: the event is delivered and the
    // row says pending. The job finished with 'delivered', which is how the sweep knows.
    it('marks delivered a row whose 2xx could not be written, and a retry is not needed', async () => {
      const row = await pendingRow(13, 45 * MINUTE)
      // A failure that waiting does not cure, so the write is not repeated and the row stays pending
      const write = jest
        .spyOn(get(deliveries), 'recordAttempt')
        .mockRejectedValueOnce(new Error('the row could not be written'))
      try {
        await get(queueService).enqueue({ deliveryId: row.id, webhookId, envelope: envelope(13) })
        await until(
          () =>
            Promise.resolve(
              received.includes(row.id) && write.mock.calls.length > 0 ? true : undefined
            ),
          'the receiver to get the event and the write to fail'
        )
      } finally {
        write.mockRestore()
      }
      // The job has to be finished, with its result kept, before the sweep reads it
      await until(async () => {
        const states = await get(queueService).jobStates()
        return states.get(row.id) === 'delivered' ? true : undefined
      }, 'the job to finish as delivered')
      expect((await statusOf(row.id))?.status).toBe('pending')

      const result = await get(retention).sweepPending()

      expect(result.delivered).toBeGreaterThanOrEqual(1)
      const swept = await statusOf(row.id)
      expect(swept).toMatchObject({ status: 'success', lastError: null, lastStatusCode: null })
      expect(swept?.deliveredAt).not.toBeNull()
      expect(received.filter(id => id === row.id)).toHaveLength(1)
    })

    // A job that ended without an attempt says nothing of the receiver: the sweep cannot claim delivery
    it('still sends to the dead letters a row whose job finished without sending', async () => {
      const row = await pendingRow(15, 45 * MINUTE)
      await get(queueService).enqueue({
        deliveryId: row.id,
        webhookId: randomUUID(),
        envelope: envelope(15)
      })
      await until(async () => {
        const states = await get(queueService).jobStates()
        return states.get(row.id) === 'completed' ? true : undefined
      }, 'the job to finish as dropped')

      await get(retention).sweepPending()

      const swept = await statusOf(row.id)
      expect(swept?.status).toBe('failed')
      expect(swept?.lastError).toMatch(/finished.*not recorded.*may already have/)
      expect(received).toEqual([])
    })

    it('marks a row whose job gave up without recording it', async () => {
      answer = 500
      const row = await pendingRow(14, 45 * MINUTE)
      await get(queueService).enqueue({ deliveryId: row.id, webhookId, envelope: envelope(14) })
      await settled(row.id, 'failed')
      await get(prisma).webhookDelivery.update({
        where: { id: row.id },
        data: { status: 'pending', lastError: null }
      })

      await get(retention).sweepPending()

      const swept = await statusOf(row.id)
      expect(swept?.status).toBe('failed')
      expect(swept?.lastError).toMatch(/gave up.*not recorded/)
    })
  })
})
