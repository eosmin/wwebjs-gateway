import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import type { EventEnvelope } from '../../src/types/events.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import {
  FakeWhatsAppClientFactory,
  type FakeWhatsAppClient
} from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

interface Suppression {
  chatId: string
  reason: string
  note: string | null
  createdAt: string
}

// Step 5.10 over the whole application with real Postgres and Redis and the fake client in place of
// Chromium: the send policy, its usage report and the suppression list go through the guards, the
// registry, the services and the send path
describe('send policy API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const id = `pol-api-${randomUUID().slice(0, 8)}`
  let app: NestFastifyApplication | undefined
  let sessions: SessionsRepository | undefined
  let redis: RedisService | undefined
  const events: EventEnvelope[] = []

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const client = (): FakeWhatsAppClient => {
    const found = factory.clientFor(id)
    if (found === undefined) throw new Error('the session did not build a client')
    return found
  }
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: unknown,
    headers: Record<string, string> = ADMIN,
    session = id
  ) =>
    application().inject({
      method,
      url: `/v1/sessions/${session}${path}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object })
    })
  const keyWith = async (scopes: string[]): Promise<Record<string, string>> => {
    const created = await application().inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: ADMIN,
      payload: { name: scopes.join('-'), sessionId: id, scopes }
    })
    return { 'x-api-key': created.json<{ key: string }>().key }
  }
  const send = (to: string) => call('POST', '/messages', { to, type: 'text', body: 'hello' }, ADMIN)

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    setEnv({ DATABASE_URL, REDIS_URL, RATE_LIMIT_MAX: '100000' })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { SessionsRepository } =
      await import('../../src/database/repositories/sessions.repository.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { EventBusService } = await import('../../src/whatsapp/event-bus.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    sessions = app.get(SessionsRepository)
    redis = app.get(RedisService)
    app.get(EventBusService).subscribe('*', envelope => {
      if (envelope.sessionId === id) events.push(envelope)
    })

    expect(
      (
        await application().inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: ADMIN,
          payload: { id }
        })
      ).statusCode
    ).toBe(201)
    expect((await call('POST', '/start')).statusCode).toBe(200)
    client().emit({ event: 'ready', data: {} })
    await until(async () => {
      const state = await application().inject({
        method: 'GET',
        url: `/v1/sessions/${id}`,
        headers: ADMIN
      })
      return state.json<{ status: string }>().status === 'ready'
    })
  })

  afterAll(async () => {
    try {
      await sessions?.delete(id)
      const keys = [...((await redis?.client.keys(`*${id}*`)) ?? []), `seq:${id}`]
      await redis?.client.del(...keys)
    } finally {
      await app?.close()
    }
  })

  describe('send-policy', () => {
    it('shows the environment defaults for a session without overrides', async () => {
      const response = await call('GET', '/send-policy')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        effective: { allowColdSends: false, optOutKeywords: [], quietHours: null },
        overrides: {}
      })
    })

    it('replaces the overrides as a whole and applies them to the next decision', async () => {
      const first = await call('PUT', '/send-policy', {
        allowColdSends: true,
        coldSendsPerDay: 7,
        optOutKeywords: [' STOP ']
      })
      expect(first.statusCode).toBe(200)
      expect(first.json()).toMatchObject({
        effective: { allowColdSends: true, coldSendsPerDay: 7, optOutKeywords: ['stop'] },
        overrides: { allowColdSends: true, coldSendsPerDay: 7, optOutKeywords: ['STOP'] }
      })

      const second = await call('PUT', '/send-policy', { coldSendsPerDay: 9 })
      expect(second.json()).toMatchObject({
        effective: { allowColdSends: false, coldSendsPerDay: 9, optOutKeywords: [] },
        overrides: { coldSendsPerDay: 9 }
      })
      expect(
        (
          await application().inject({ method: 'GET', url: `/v1/sessions/${id}`, headers: ADMIN })
        ).json<{ settings: Record<string, unknown> }>().settings
      ).toHaveProperty('sendPolicy', { coldSendsPerDay: 9 })

      const cleared = await call('PUT', '/send-policy', {})
      expect(cleared.json()).toMatchObject({ overrides: {}, effective: { coldSendsPerDay: 20 } })
    })

    it('keeps the other settings of the session', async () => {
      await call('PUT', '/send-policy', { coldSendsPerDay: 5 })
      await application().inject({
        method: 'PATCH',
        url: `/v1/sessions/${id}`,
        headers: ADMIN,
        payload: { settings: { ordering: { enabled: false } } }
      })

      const settings = (
        await application().inject({ method: 'GET', url: `/v1/sessions/${id}`, headers: ADMIN })
      ).json<{ settings: Record<string, unknown> }>().settings

      expect(settings).toEqual({ ordering: { enabled: false }, sendPolicy: { coldSendsPerDay: 5 } })
      await call('PUT', '/send-policy', {})
    })

    it.each([
      { coldSendsPerDay: 1_000_000 },
      { coldSendsPerDay: -1 },
      { unknown: true },
      { quietHours: { from: '25:00', to: '07:00', timezone: 'UTC' } },
      { quietHours: { from: '22:00', to: '07:00', timezone: 'Not/AZone' } }
    ])('refuses %j with 400 and keeps the overrides', async body => {
      const response = await call('PUT', '/send-policy', body)

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
      expect((await call('GET', '/send-policy')).json()).toMatchObject({ overrides: {} })
    })

    it('needs read to look and manage to change, and the session to exist', async () => {
      const reader = await keyWith(['read'])

      expect((await call('GET', '/send-policy', undefined, reader)).statusCode).toBe(200)
      expect((await call('GET', '/send-policy/usage', undefined, reader)).statusCode).toBe(200)
      const denied = await call('PUT', '/send-policy', {}, reader)
      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
      const missing = await call('GET', '/send-policy', undefined, ADMIN, `${id}-nope`)
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
      expect((await call('PUT', '/send-policy', {}, ADMIN, `${id}-nope`)).statusCode).toBe(404)
    })
  })

  describe('send-policy/usage', () => {
    it('reports the budgets, and a send spends from them', async () => {
      await call('PUT', '/send-policy', { allowColdSends: true, coldSendsPerDay: 50 })
      const before = (await call('GET', '/send-policy/usage')).json<{
        coldSends: { used: number }
        buckets: { perMinute: { available: number; limit: number } }
        lookups: { used: number }
      }>()

      const sent = await send(`5215500${Math.floor(Math.random() * 1e6)}`.slice(0, 13))
      expect(sent.statusCode).toBeLessThan(300)
      await until(
        async () =>
          (await call('GET', '/send-policy/usage')).json<{ coldSends: { used: number } }>()
            .coldSends.used ===
          before.coldSends.used + 1
      )

      const after = (await call('GET', '/send-policy/usage')).json<typeof before>()
      expect(after.lookups.used).toBe(before.lookups.used + 1)
      expect(after.buckets.perMinute.available).toBeLessThan(before.buckets.perMinute.available)
      expect(after.buckets.perMinute.limit).toBe(before.buckets.perMinute.limit)
      expect(after).toMatchObject({
        throttle: { active: false, until: null },
        warmup: { days: 14 }
      })
      await call('PUT', '/send-policy', {})
    })
  })

  describe('suppressions', () => {
    it('adds a chat once, publishes chat_suppressed once, and the send is rejected', async () => {
      const chatId = `${Math.floor(Math.random() * 1e10)}@c.us`
      events.length = 0

      const added = await call('POST', '/suppressions', { chatId, note: 'asked by phone' })
      const again = await call('POST', '/suppressions', { chatId, note: 'other' })

      expect(added.statusCode).toBe(200)
      expect(added.json()).toMatchObject({
        chatId,
        reason: 'manual',
        note: 'asked by phone',
        created: true
      })
      expect(again.json()).toMatchObject({ chatId, note: 'asked by phone', created: false })
      await until(() => events.some(event => event.event === 'chat_suppressed'))
      expect(events.filter(event => event.event === 'chat_suppressed')).toEqual([
        expect.objectContaining({ data: { chatId, reason: 'manual' } })
      ])
      const rejected = await send(chatId)
      expect(rejected.statusCode).toBe(422)
      expect(rejected.json()).toMatchObject({ error: { code: 'RECIPIENT_SUPPRESSED' } })

      const listed = (await call('GET', '/suppressions')).json<{ items: Suppression[] }>()
      expect(listed.items.map(item => item.chatId)).toContain(chatId)
      expect(
        (await call('GET', '/send-policy/usage')).json<{ suppressedChats: number }>()
          .suppressedChats
      ).toBeGreaterThanOrEqual(1)

      const removed = await call('DELETE', `/suppressions/${encodeURIComponent(chatId)}`)
      expect(removed.statusCode).toBe(204)
      expect((await call('DELETE', `/suppressions/${encodeURIComponent(chatId)}`)).statusCode).toBe(
        404
      )
      expect(
        (await call('GET', '/suppressions')).json<{ items: Suppression[] }>().items
      ).not.toContainEqual(expect.objectContaining({ chatId }))
    })

    it('turns a phone number into the id the sends use', async () => {
      const number = `52${Math.floor(Math.random() * 1e10)
        .toString()
        .padStart(10, '0')}`

      const added = await call('POST', '/suppressions', { chatId: `+${number}` })

      expect(added.statusCode).toBe(200)
      expect(added.json()).toMatchObject({ chatId: `${number}@c.us`, created: true })
      await call('DELETE', `/suppressions/${number}@c.us`)
    })

    it.each([
      { chatId: 'status@broadcast' },
      { chatId: 'abc' },
      { chatId: '1@lid', reason: 'x' },
      {}
    ])('refuses %j with 400', async body => {
      const response = await call('POST', '/suppressions', body)

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    })

    it('needs manage to change and read to look', async () => {
      const reader = await keyWith(['read'])
      const manager = await keyWith(['manage'])

      expect((await call('GET', '/suppressions', undefined, reader)).statusCode).toBe(200)
      expect((await call('POST', '/suppressions', { chatId: '1@lid' }, reader)).statusCode).toBe(
        403
      )
      expect((await call('DELETE', '/suppressions/1@lid', undefined, reader)).statusCode).toBe(403)
      expect((await call('GET', '/suppressions', undefined, manager)).statusCode).toBe(403)
      expect(
        (await call('POST', '/suppressions', { chatId: '1@lid' }, ADMIN, `${id}-nope`)).statusCode
      ).toBe(404)
    })
  })

  describe('unreachable-chats', () => {
    it('lists the chats flagged in Redis, only those of the session', async () => {
      const { RedisPolicyStateStore } = await import('../../src/services/send-policy.store.js')
      const store = new RedisPolicyStateStore(
        application().get((await import('../../src/infra/redis/redis.service.js')).RedisService)
      )
      await store.flagUnreachable(id, 'dead@c.us')
      await store.flagUnreachable(`${id}x`, 'other@c.us')

      const response = await call('GET', '/unreachable-chats')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [{ chatId: 'dead@c.us' }], truncated: false })
      await store.clearUnreachable(id, 'dead@c.us')
      await store.clearUnreachable(`${id}x`, 'other@c.us')
      expect((await call('GET', '/unreachable-chats')).json()).toEqual({
        items: [],
        truncated: false
      })
    })
  })

  it('exposes the decisions and the suppressed chats as metrics', async () => {
    const metrics = await application().inject({
      method: 'GET',
      url: '/metrics',
      headers: ADMIN
    })

    expect(metrics.statusCode).toBe(200)
    expect(metrics.body).toContain('gw_policy_decisions_total')
    expect(metrics.body).toContain('gw_suppressed_chats')
  })
})
