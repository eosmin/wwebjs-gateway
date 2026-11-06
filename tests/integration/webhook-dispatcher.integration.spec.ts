import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'

import type { DeliveriesRepository } from '../../src/database/repositories/deliveries.repository.js'
import type { WebhooksRepository } from '../../src/database/repositories/webhooks.repository.js'
import type { EventEnvelope } from '../../src/types/events.js'
import type { EventBusService } from '../../src/whatsapp/event-bus.service.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import { FakeWhatsAppClientFactory } from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const URL_OK = 'https://8.8.8.8/hook'

interface QueuedJob {
  deliveryId: string
  envelope: { id: string; event: string; seq: number; data: Record<string, unknown> }
}

// Step 7.3 over the whole application with real Postgres and Redis: an event published on the bus
// becomes a row of `webhook_deliveries` and a job for each webhook that wants it. Nothing consumes
// the queue yet (7.4), so the jobs stay where the dispatcher put them.
describe('webhook dispatcher (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const suffix = randomUUID().slice(0, 8)
  const mine = `wh-dsp-${suffix}`
  const other = `wh-dso-${suffix}`
  let app: NestFastifyApplication | undefined
  let bus: EventBusService | undefined
  let webhooks: WebhooksRepository | undefined
  let deliveries: DeliveriesRepository | undefined
  let queue: Queue | undefined
  let seq = 0

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const createWebhook = async (body: Record<string, unknown>): Promise<string> => {
    const response = await application().inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: ADMIN,
      payload: { url: URL_OK, ...body }
    })
    expect(response.statusCode).toBe(201)
    return response.json<{ id: string }>().id
  }
  const publish = (sessionId: string, event: string, data: unknown): number => {
    seq += 1
    bus?.publish({
      id: `evt_${randomUUID()}`,
      event,
      sessionId,
      seq,
      timestamp: '2026-01-01T00:00:00.000Z',
      data
    } as unknown as EventEnvelope)
    return seq
  }
  // The dispatcher is not awaited by the bus: poll until the rows of the webhook are there
  const rowsOf = async (webhookId: string, expected: number) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await deliveries?.listForWebhook(webhookId, { limit: 50 })
      if ((rows?.length ?? 0) >= expected) return rows ?? []
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return (await deliveries?.listForWebhook(webhookId, { limit: 50 })) ?? []
  }
  const jobOf = async (deliveryId: string): Promise<QueuedJob | undefined> => {
    const jobs = await queue?.getJobs(['waiting', 'delayed', 'prioritized'])
    return (jobs ?? []).map(job => job.data as QueuedJob).find(job => job.deliveryId === deliveryId)
  }

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    setEnv({ DATABASE_URL, REDIS_URL, RATE_LIMIT_MAX: '100000' })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { WebhooksRepository } =
      await import('../../src/database/repositories/webhooks.repository.js')
    const { DeliveriesRepository } =
      await import('../../src/database/repositories/deliveries.repository.js')
    const { EventBusService } = await import('../../src/whatsapp/event-bus.service.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')
    const { DELIVERY_QUEUE_NAME } = await import('../../src/services/delivery-queue.service.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    bus = app.get(EventBusService)
    webhooks = app.get(WebhooksRepository)
    deliveries = app.get(DeliveriesRepository)
    queue = new Queue(DELIVERY_QUEUE_NAME, { connection: app.get(RedisService).client })
    for (const id of [mine, other]) {
      const response = await application().inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: ADMIN,
        payload: { id }
      })
      expect(response.statusCode).toBe(201)
    }
  })

  afterAll(async () => {
    try {
      const { SessionsRepository } =
        await import('../../src/database/repositories/sessions.repository.js')
      const jobs = await queue?.getJobs(['waiting', 'delayed', 'prioritized'])
      for (const job of jobs ?? []) {
        const sessionId = (job.data as { envelope?: { sessionId?: string } }).envelope?.sessionId
        if (sessionId?.endsWith(suffix) === true) await job.remove()
      }
      // The webhooks and their deliveries go with the sessions (cascade)
      const sessions = application().get(SessionsRepository)
      for (const id of [mine, other]) await sessions.delete(id)
    } finally {
      await queue?.close()
      await app?.close()
    }
  })

  it('stores a row and queues a job, with the same id and the envelope as it was published', async () => {
    const id = await createWebhook({ sessionId: mine, events: ['message'] })
    const sent = publish(mine, 'message', { id: 'm1', body: 'hi' })

    const [row, ...rest] = await rowsOf(id, 1)
    expect(rest).toHaveLength(0)
    expect(row).toMatchObject({
      webhookId: id,
      sessionId: mine,
      event: 'message',
      status: 'pending'
    })
    expect(Number(row?.seq)).toBe(sent)
    const job = await jobOf(row?.id ?? '')
    expect(job?.envelope).toMatchObject({
      event: 'message',
      seq: sent,
      data: { id: 'm1', body: 'hi' }
    })
  })

  it('filters by session and by event, and "*" and a null session take everything', async () => {
    const own = await createWebhook({ sessionId: mine, events: ['message'] })
    const everySession = await createWebhook({ events: ['message'] })
    const everything = await createWebhook({ sessionId: mine, events: ['*'] })
    const otherSession = await createWebhook({ sessionId: other, events: ['message'] })

    publish(mine, 'message', { id: 'm2' })
    publish(mine, 'session_status', { status: 'ready', previous: 'starting' })

    expect(await rowsOf(own, 1)).toHaveLength(1)
    expect(await rowsOf(everySession, 1)).toHaveLength(1)
    expect(await rowsOf(everything, 2)).toHaveLength(2)
    // A moment for any delivery that should not exist to show up
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await rowsOf(otherSession, 0)).toHaveLength(0)
    expect((await rowsOf(own, 1)).map(row => row.event)).toEqual(['message'])
  })

  it('keeps the QR out of the table and in the job', async () => {
    const id = await createWebhook({ sessionId: mine, events: ['qr'] })
    publish(mine, 'qr', { qr: '2@abcdefghijklmnop' })

    const [row] = await rowsOf(id, 1)
    expect(JSON.stringify(row?.payload)).not.toContain('abcdefghijklmnop')
    const job = await jobOf(row?.id ?? '')
    expect(job?.envelope.data).toEqual({ qr: '2@abcdefghijklmnop' })
  })

  it("shapes each webhook's copy by its raw and media settings", async () => {
    const message = {
      id: 'm3',
      raw: { internal: true },
      media: { mimetype: 'image/png', downloadUrl: 'u', base64: 'AAAA' }
    }
    const plain = await createWebhook({
      sessionId: mine,
      events: ['message_create'],
      includeRaw: false,
      mediaMode: 'none'
    })
    const inline = await createWebhook({
      sessionId: mine,
      events: ['message_create'],
      mediaMode: 'inline'
    })
    publish(mine, 'message_create', message)

    const [plainRow] = await rowsOf(plain, 1)
    const [inlineRow] = await rowsOf(inline, 1)
    const plainJob = await jobOf(plainRow?.id ?? '')
    const inlineJob = await jobOf(inlineRow?.id ?? '')
    expect(plainJob?.envelope.data).toEqual({ id: 'm3' })
    expect(inlineJob?.envelope.data).toMatchObject({
      raw: { internal: true },
      media: { base64: 'AAAA' }
    })
    // The table never keeps inline media, whatever the mode
    expect(JSON.stringify(inlineRow?.payload)).not.toContain('AAAA')
    expect(JSON.stringify(inlineRow?.payload)).toContain('"raw"')
  })

  it('does not deliver to a webhook that is disabled or deleted, and sees an update at once', async () => {
    const id = await createWebhook({ sessionId: mine, events: ['message'] })
    publish(mine, 'message', { id: 'm4' })
    expect(await rowsOf(id, 1)).toHaveLength(1)

    const disabled = await application().inject({
      method: 'PATCH',
      url: `/v1/webhooks/${id}`,
      headers: ADMIN,
      payload: { enabled: false }
    })
    expect(disabled.statusCode).toBe(200)
    publish(mine, 'message', { id: 'm5' })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await rowsOf(id, 0)).toHaveLength(1)

    await application().inject({
      method: 'PATCH',
      url: `/v1/webhooks/${id}`,
      headers: ADMIN,
      payload: { enabled: true }
    })
    publish(mine, 'message', { id: 'm6' })
    expect(await rowsOf(id, 2)).toHaveLength(2)
    await webhooks?.delete(id)
  })
})
