import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'

import type { DeliveriesRepository } from '../../src/database/repositories/deliveries.repository.js'
import type { WebhooksRepository } from '../../src/database/repositories/webhooks.repository.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import { FakeWhatsAppClientFactory } from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const URL_OK = 'https://8.8.8.8/hook'

interface WebhookBody {
  id: string
  sessionId: string | null
  url: string
  events: string[]
  secret?: string
}

interface DeliveryBody {
  id: string
  status: string
  event: string
  attempts: number
  seq: number
}

// Step 7.2 over the whole application with real Postgres and Redis: the webhooks routes go through
// the guards, the registry, the services, the table of deliveries and the queue the processor (7.4)
// reads. The queue is paused for the run, so the jobs stay where the routes put them and nothing is
// sent (the processor has its own suite).
describe('webhooks API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const suffix = randomUUID().slice(0, 8)
  const mine = `wh-api-${suffix}`
  const other = `wh-oth-${suffix}`
  let app: NestFastifyApplication | undefined
  let webhooks: WebhooksRepository | undefined
  let deliveries: DeliveriesRepository | undefined
  let queue: Queue | undefined
  const created: string[] = []
  const keysOf: Record<string, Record<string, string>> = {}

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: unknown,
    headers: Record<string, string> = ADMIN
  ) =>
    application().inject({
      method,
      url: `/v1/webhooks${path}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object })
    })
  const createWebhook = async (
    body: Record<string, unknown>,
    headers: Record<string, string> = ADMIN
  ): Promise<WebhookBody> => {
    const response = await call('POST', '', { url: URL_OK, ...body }, headers)
    expect(response.statusCode).toBe(201)
    const webhook = response.json<WebhookBody>()
    created.push(webhook.id)
    return webhook
  }
  const seedDelivery = async (
    webhookId: string,
    seq: number,
    status: 'failed' | 'success' | 'pending'
  ): Promise<string> => {
    const row = await deliveries?.create({
      webhookId,
      sessionId: mine,
      event: 'message',
      seq: BigInt(seq),
      payload: {
        id: `evt_${randomUUID()}`,
        event: 'message',
        sessionId: mine,
        seq,
        timestamp: '2026-01-01T00:00:00.000Z',
        data: { body: '[redacted]' }
      }
    })
    if (row === undefined) throw new Error('no repository')
    if (status !== 'pending') {
      await deliveries?.recordAttempt(
        row.id,
        status === 'failed' ? { status, statusCode: 503, error: 'HTTP 503' } : { status },
        new Date()
      )
    }
    return row.id
  }
  // The jobs of the deliveries of this run that wait in the queue of the processor
  const queued = async (): Promise<string[]> => {
    const jobs = await queue?.getJobs(['waiting', 'delayed', 'prioritized'])
    return (jobs ?? []).map(job => (job.data as { deliveryId: string }).deliveryId)
  }
  const keyFor = async (sessionId: string): Promise<Record<string, string>> => {
    const response = await application().inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: ADMIN,
      payload: { name: `wh-${sessionId}`, sessionId, scopes: ['webhooks', 'read'] }
    })
    return { 'x-api-key': response.json<{ key: string }>().key }
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
    webhooks = app.get(WebhooksRepository)
    deliveries = app.get(DeliveriesRepository)
    queue = new Queue(DELIVERY_QUEUE_NAME, { connection: app.get(RedisService).client })
    // The processor of the application would send these jobs: no worker takes anything while paused
    await queue.pause()
    for (const id of [mine, other]) {
      const response = await application().inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: ADMIN,
        payload: { id }
      })
      expect(response.statusCode).toBe(201)
    }
    keysOf[mine] = await keyFor(mine)
  })

  afterAll(async () => {
    try {
      const { SessionsRepository } =
        await import('../../src/database/repositories/sessions.repository.js')
      // The webhooks go with the sessions (cascade); the jobs of their deliveries are ours to remove
      const jobs = await queue?.getJobs(['waiting', 'delayed', 'prioritized'])
      for (const job of jobs ?? []) {
        if (
          (job.data as { envelope?: { sessionId?: string } }).envelope?.sessionId?.endsWith(suffix)
        ) {
          await job.remove()
        }
      }
      for (const id of created) await webhooks?.delete(id)
      const sessions = application().get(SessionsRepository)
      for (const id of [mine, other]) await sessions.delete(id)
    } finally {
      await queue?.resume()
      await queue?.close()
      await app?.close()
    }
  })

  describe('webhooks', () => {
    it('creates a webhook, shows its secret once and never again', async () => {
      const webhook = await createWebhook({ sessionId: mine, events: ['message', 'message'] })

      expect(webhook.secret).toMatch(/^whsec_/)
      expect(webhook.events).toEqual(['message'])
      const read = await call('GET', `/${webhook.id}`)
      expect(read.statusCode).toBe(200)
      expect(read.json()).toMatchObject({ id: webhook.id, sessionId: mine, url: URL_OK })
      expect(read.json()).not.toHaveProperty('secret')
      const listed = await call('GET', '')
      expect(JSON.stringify(listed.json())).not.toContain('whsec_')
    })

    it('refuses a private address, an unknown session and an unknown field', async () => {
      const privateUrl = await call('POST', '', { url: 'http://127.0.0.1/hook' })
      const unknown = await call('POST', '', { url: URL_OK, sessionId: `nope-${suffix}` })
      const extra = await call('POST', '', { url: URL_OK, secret: 'whsec_mine' })

      expect(privateUrl.statusCode).toBe(400)
      expect(unknown.statusCode).toBe(404)
      expect(extra.statusCode).toBe(400)
    })

    it('changes a webhook, and refuses an empty change and an id that is not a uuid', async () => {
      const webhook = await createWebhook({ sessionId: mine })

      const changed = await call('PATCH', `/${webhook.id}`, { enabled: false, events: ['*'] })
      const empty = await call('PATCH', `/${webhook.id}`, {})
      const badId = await call('GET', '/not-a-uuid')

      expect(changed.json()).toMatchObject({ enabled: false, events: ['*'] })
      expect(empty.statusCode).toBe(400)
      expect(badId.statusCode).toBe(400)
    })

    it('rotates the secret: a new one in the answer, the stored one replaced', async () => {
      const webhook = await createWebhook({ sessionId: mine })
      const before = (await webhooks?.findById(webhook.id))?.secret

      const rotated = await call('POST', `/${webhook.id}/rotate-secret`)

      expect(rotated.statusCode).toBe(200)
      const secret = rotated.json<WebhookBody>().secret
      expect(secret).toMatch(/^whsec_/)
      expect(secret).not.toBe(before)
      expect((await webhooks?.findById(webhook.id))?.secret).toBe(secret)
    })

    it('deletes a webhook with its deliveries', async () => {
      const webhook = await createWebhook({ sessionId: mine })
      const deliveryId = await seedDelivery(webhook.id, 1, 'failed')

      const deleted = await call('DELETE', `/${webhook.id}`)

      expect(deleted.statusCode).toBe(204)
      expect((await call('GET', `/${webhook.id}`)).statusCode).toBe(404)
      expect(await deliveries?.findById(deliveryId)).toBeNull()
      expect((await call('DELETE', `/${webhook.id}`)).statusCode).toBe(404)
    })
  })

  describe('session keys', () => {
    it('lets a session key manage the webhooks of its own session only', async () => {
      const key = keysOf[mine] ?? {}
      const own = await createWebhook({ sessionId: mine }, key)
      const foreign = await createWebhook({ sessionId: other })
      const global = await createWebhook({})

      const everyone = await call('GET', '', undefined, key)
      expect(everyone.json<{ webhooks: WebhookBody[] }>().webhooks.map(w => w.id)).toContain(own.id)
      const ids = everyone.json<{ webhooks: WebhookBody[] }>().webhooks.map(w => w.id)
      expect(ids).not.toContain(foreign.id)
      expect(ids).not.toContain(global.id)
      expect((await call('GET', `/${own.id}`, undefined, key)).statusCode).toBe(200)
      expect((await call('GET', `/${foreign.id}`, undefined, key)).statusCode).toBe(403)
      expect((await call('GET', `/${global.id}`, undefined, key)).statusCode).toBe(403)
    })

    it('refuses a session key to create a webhook for another session or for every session', async () => {
      const key = keysOf[mine] ?? {}

      expect((await call('POST', '', { url: URL_OK, sessionId: other }, key)).statusCode).toBe(403)
      expect((await call('POST', '', { url: URL_OK }, key)).statusCode).toBe(403)
    })

    it('keeps everything under a webhook of another session out of reach', async () => {
      const key = keysOf[mine] ?? {}
      const foreign = await createWebhook({ sessionId: other })
      const deliveryId = await seedDelivery(foreign.id, 1, 'failed')
      const reached = [
        call('PATCH', `/${foreign.id}`, { enabled: false }, key),
        call('DELETE', `/${foreign.id}`, undefined, key),
        call('POST', `/${foreign.id}/rotate-secret`, undefined, key),
        call('POST', `/${foreign.id}/test`, undefined, key),
        call('GET', `/${foreign.id}/deliveries`, undefined, key),
        call('POST', `/${foreign.id}/deliveries/${deliveryId}/retry`, undefined, key),
        call('POST', `/${foreign.id}/deliveries/retry-failed`, undefined, key)
      ]

      for (const response of await Promise.all(reached)) expect(response.statusCode).toBe(403)
      expect((await call('GET', `/${foreign.id}`)).json()).toMatchObject({ enabled: true })
      expect((await deliveries?.findById(deliveryId))?.status).toBe('failed')
    })

    it('refuses a key without the webhooks scope', async () => {
      const response = await application().inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: ADMIN,
        payload: { name: 'no-webhooks', sessionId: mine, scopes: ['read'] }
      })
      const key = { 'x-api-key': response.json<{ key: string }>().key }

      expect((await call('GET', '', undefined, key)).statusCode).toBe(403)
    })
  })

  describe('test', () => {
    it('queues a ping and answers the pending delivery', async () => {
      const webhook = await createWebhook({ sessionId: mine })

      const response = await call('POST', `/${webhook.id}/test`)

      expect(response.statusCode).toBe(202)
      const delivery = response.json<DeliveryBody>()
      expect(delivery).toMatchObject({ event: 'ping', status: 'pending', attempts: 0 })
      expect(await queued()).toContain(delivery.id)
      const jobs = (await queue?.getJobs(['waiting', 'delayed', 'prioritized'])) ?? []
      const job = jobs.find(j => (j.data as { deliveryId: string }).deliveryId === delivery.id)
      expect(job?.opts.attempts).toBeGreaterThan(0)
      expect(job?.data).toMatchObject({ envelope: { event: 'ping', sessionId: mine, data: {} } })
      const listed = await call('GET', `/${webhook.id}/deliveries`)
      expect(listed.json<{ items: DeliveryBody[] }>().items.map(d => d.id)).toEqual([delivery.id])
    })

    it('needs a session for a webhook of every session', async () => {
      const webhook = await createWebhook({})

      expect((await call('POST', `/${webhook.id}/test`)).statusCode).toBe(400)
      expect(
        (await call('POST', `/${webhook.id}/test`, { sessionId: `nope-${suffix}` })).statusCode
      ).toBe(404)
      const ok = await call('POST', `/${webhook.id}/test`, { sessionId: mine })
      expect(ok.statusCode).toBe(202)
    })
  })

  describe('deliveries', () => {
    it('lists newest first with a cursor and filters by status', async () => {
      const webhook = await createWebhook({ sessionId: mine })
      await seedDelivery(webhook.id, 1, 'failed')
      await seedDelivery(webhook.id, 2, 'success')
      await seedDelivery(webhook.id, 3, 'failed')

      const first = await call('GET', `/${webhook.id}/deliveries?limit=2`)
      const firstBody = first.json<{ items: DeliveryBody[]; nextCursor: string | null }>()
      const second = await call(
        'GET',
        `/${webhook.id}/deliveries?limit=2&cursor=${firstBody.nextCursor ?? ''}`
      )
      const failed = await call('GET', `/${webhook.id}/deliveries?status=failed`)

      expect(firstBody.items.map(d => d.seq)).toEqual([3, 2])
      expect(firstBody.items[0]).not.toHaveProperty('payload')
      expect(second.json<{ items: DeliveryBody[] }>().items.map(d => d.seq)).toEqual([1])
      expect(second.json<{ nextCursor: string | null }>().nextCursor).toBeNull()
      expect(failed.json<{ items: DeliveryBody[] }>().items.map(d => d.seq)).toEqual([3, 1])
      expect((await call('GET', `/${webhook.id}/deliveries?cursor=garbage`)).statusCode).toBe(400)
      expect((await call('GET', `/${webhook.id}/deliveries?status=odd`)).statusCode).toBe(400)
    })

    it('retries a dead letter once, and only a dead letter', async () => {
      const webhook = await createWebhook({ sessionId: mine })
      const dead = await seedDelivery(webhook.id, 1, 'failed')
      const delivered = await seedDelivery(webhook.id, 2, 'success')
      const waiting = await seedDelivery(webhook.id, 3, 'pending')
      const retry = (id: string) => call('POST', `/${webhook.id}/deliveries/${id}/retry`)

      const first = await retry(dead)
      const again = await retry(dead)

      expect(first.statusCode).toBe(202)
      expect(first.json()).toMatchObject({ id: dead, status: 'pending', attempts: 1 })
      expect(again.statusCode).toBe(404)
      expect((await queued()).filter(id => id === dead)).toHaveLength(1)
      expect((await retry(delivered)).statusCode).toBe(404)
      expect((await retry(waiting)).statusCode).toBe(404)
      expect((await retry(randomUUID())).statusCode).toBe(404)
      expect(await queued()).not.toContain(delivered)
      expect(await queued()).not.toContain(waiting)
    })

    it('does not retry the delivery of another webhook through this one', async () => {
      const webhook = await createWebhook({ sessionId: mine })
      const sibling = await createWebhook({ sessionId: mine })
      const theirs = await seedDelivery(sibling.id, 1, 'failed')

      const response = await call('POST', `/${webhook.id}/deliveries/${theirs}/retry`)

      expect(response.statusCode).toBe(404)
      expect((await deliveries?.findById(theirs))?.status).toBe('failed')
    })

    it('retries all the dead letters of a webhook and none of another', async () => {
      const webhook = await createWebhook({ sessionId: mine })
      const sibling = await createWebhook({ sessionId: mine })
      const dead = [
        await seedDelivery(webhook.id, 1, 'failed'),
        await seedDelivery(webhook.id, 2, 'failed'),
        await seedDelivery(webhook.id, 3, 'failed')
      ]
      const delivered = await seedDelivery(webhook.id, 4, 'success')
      const theirs = await seedDelivery(sibling.id, 1, 'failed')

      const response = await call('POST', `/${webhook.id}/deliveries/retry-failed`)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ retried: 3, more: false })
      const waiting = await queued()
      for (const id of dead) expect(waiting.filter(w => w === id)).toHaveLength(1)
      expect(waiting).not.toContain(delivered)
      expect(waiting).not.toContain(theirs)
      expect((await deliveries?.findById(theirs))?.status).toBe('failed')
      expect((await call('POST', `/${webhook.id}/deliveries/retry-failed`)).json()).toEqual({
        retried: 0,
        more: false
      })
    })

    it('answers 404 for a webhook that does not exist, on every route under it', async () => {
      const missing = randomUUID()

      for (const [method, path] of [
        ['POST', `/${missing}/test`],
        ['GET', `/${missing}/deliveries`],
        ['POST', `/${missing}/deliveries/retry-failed`],
        ['POST', `/${missing}/deliveries/${randomUUID()}/retry`]
      ] as const) {
        expect((await call(method, path)).statusCode).toBe(404)
      }
    })
  })

  it('has no secret in the answers of the routes that do not create one', async () => {
    const webhook = await createWebhook({ sessionId: mine })
    const updated = await call('PATCH', `/${webhook.id}`, { enabled: true })
    const tested = await call('POST', `/${webhook.id}/test`)

    expect(JSON.stringify([updated.json(), tested.json()])).not.toContain('whsec_')
  })
})
