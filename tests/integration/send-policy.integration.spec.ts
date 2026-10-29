import { randomUUID } from 'node:crypto'

import type { TestingModule } from '@nestjs/testing'

import { parseEnv } from '../../src/config/env.schema.js'
import { MessagesRepository } from '../../src/database/repositories/messages.repository.js'
import { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import { SuppressionsRepository } from '../../src/database/repositories/suppressions.repository.js'
import { RedisService } from '../../src/infra/redis/redis.service.js'
import { SendPolicyService } from '../../src/services/send-policy.service.js'
import { emptyPolicyState } from '../../src/services/send-policy.state.js'
import {
  RedisPolicyStateStore,
  UnreadablePolicyState
} from '../../src/services/send-policy.store.js'
import { buildDatabaseModule } from '../helpers/database.js'
import { REAL_ENV, TEST_ENV } from '../helpers/env.js'

const HOUR = 3_600_000

describe('send policy (integration)', () => {
  let module: TestingModule
  let messages: MessagesRepository
  let sessions: SessionsRepository
  let suppressions: SuppressionsRepository
  let redis: RedisService
  let store: RedisPolicyStateStore
  const runId = randomUUID().slice(0, 8)
  const sessionIds: string[] = []

  const redisUrl = REAL_ENV.REDIS_URL
  if (redisUrl === undefined) throw new Error('REDIS_URL is required by the integration suites')
  const policyConfig = (env: Record<string, string> = {}): ReturnType<typeof parseEnv> =>
    parseEnv({
      ...TEST_ENV,
      REDIS_URL: redisUrl,
      PER_CHAT_MIN_INTERVAL_MS: '0',
      WARMUP_DAYS: '0',
      ...env
    })

  // A new service over the same Redis and Postgres: what a restarted process has
  const build = (env: Record<string, string> = {}): SendPolicyService =>
    new SendPolicyService(policyConfig(env), messages, suppressions, sessions, store)

  const newSession = async (name: string): Promise<string> => {
    const id = `pol-${name}-${runId}`
    sessionIds.push(id)
    await sessions.create({ id })
    return id
  }

  const stored = (sessionId: string, id: string, over: Record<string, unknown> = {}) =>
    messages.upsert({
      id,
      sessionId,
      chatId: 'chat@c.us',
      direction: 'in',
      fromMe: false,
      type: 'chat',
      body: 'hi',
      hasMedia: false,
      ack: 0,
      sentAt: new Date(),
      receivedAt: new Date(),
      dto: { id },
      ...over
    })

  beforeAll(async () => {
    module = await buildDatabaseModule()
    await module.init()
    messages = module.get(MessagesRepository)
    sessions = module.get(SessionsRepository)
    suppressions = module.get(SuppressionsRepository)
    redis = new RedisService(policyConfig())
    await redis.client.ping()
    store = new RedisPolicyStateStore(redis)
    await sessions.list()
  })

  afterAll(async () => {
    for (const id of sessionIds) {
      await store.delete(id)
      await sessions.delete(id)
    }
    await redis.onApplicationShutdown()
    await module.close()
  })

  describe('the Redis store', () => {
    it('saves a state with an expiry and reads the same state back', async () => {
      const sessionId = await newSession('roundtrip')
      const state = {
        ...emptyPolicyState(),
        perMinute: { tokens: -1.5, at: 1234 },
        chats: [{ chatId: 'a@c.us', lastAt: 5, perMinute: { tokens: 3, at: 5 } }],
        sent: [{ hash: 'abc', chatId: 'a@c.us', at: 7 }],
        results: [true, false]
      }

      await store.save(sessionId, state)

      expect(await store.load(sessionId)).toEqual(state)
      expect(await redis.client.ttl(`policy:state:${sessionId}`)).toBeGreaterThan(0)
    })

    it('answers null for a session with nothing saved', async () => {
      expect(await store.load(`pol-none-${runId}`)).toBeNull()
    })

    it.each([
      ['text that is not JSON', '{nope'],
      ['JSON of another shape', '{"version":1,"chats":"x"}'],
      ['a state with an unknown key', JSON.stringify({ ...emptyPolicyState(), extra: 1 })],
      [
        'a chat id that is too long',
        JSON.stringify({
          ...emptyPolicyState(),
          coldChats: [{ chatId: 'x'.repeat(129), at: 1 }]
        })
      ],
      ['a negative time', JSON.stringify({ ...emptyPolicyState(), lookups: [-1] })]
    ])(
      'refuses to read %s, so the service can throttle instead of starting full',
      async (name, raw) => {
        const sessionId = await newSession(`corrupt-${name.replace(/\W+/g, '-').slice(0, 20)}`)
        await redis.client.set(`policy:state:${sessionId}`, raw)

        await expect(store.load(sessionId)).rejects.toBeInstanceOf(UnreadablePolicyState)
      }
    )

    it.each(['bad*id', 'a:b', 'x[1]', '', 'a'.repeat(65), 'with space'])(
      'refuses the session id %j before it reaches a key or a SCAN pattern',
      async sessionId => {
        await expect(store.load(sessionId)).rejects.toThrow(RangeError)
        await expect(store.flagUnreachable(sessionId, 'a@c.us')).rejects.toThrow(RangeError)
        await expect(store.delete(sessionId)).rejects.toThrow(RangeError)
      }
    )

    it('sets the unreachable flag once and clears it once', async () => {
      const sessionId = await newSession('flag')

      expect(await store.flagUnreachable(sessionId, 'a@c.us')).toBe(true)
      expect(await store.flagUnreachable(sessionId, 'a@c.us')).toBe(false)
      expect(await redis.client.ttl(`policy:unreachable:${sessionId}:a@c.us`)).toBeGreaterThan(0)
      expect(await store.clearUnreachable(sessionId, 'a@c.us')).toBe(true)
      expect(await store.clearUnreachable(sessionId, 'a@c.us')).toBe(false)
    })

    it('deletes the state and every flag of one session only', async () => {
      const sessionId = await newSession('delete')
      const other = await newSession('delete-other')
      await store.save(sessionId, emptyPolicyState())
      await store.flagUnreachable(sessionId, 'a@c.us')
      await store.flagUnreachable(sessionId, 'b@c.us')
      await store.flagUnreachable(other, 'a@c.us')

      await store.delete(sessionId)

      expect(await store.load(sessionId)).toBeNull()
      expect(await store.clearUnreachable(sessionId, 'a@c.us')).toBe(false)
      expect(await store.clearUnreachable(other, 'a@c.us')).toBe(true)
    })
  })

  describe('the service over Postgres and Redis', () => {
    it('lets a reply into an open conversation through and spends the budget', async () => {
      const sessionId = await newSession('open')
      await stored(sessionId, 'in1')

      const decision = await build().admit({
        sessionId,
        chatId: 'chat@c.us',
        body: 'hola',
        waitedMs: 0
      })

      expect(decision).toEqual({ decision: 'allow' })
      expect((await store.load(sessionId))?.perMinute).toBeDefined()
    })

    it('does not hand the budget out again to a process that restarts', async () => {
      const sessionId = await newSession('restart')
      await stored(sessionId, 'in1')
      const env = { SESSION_MAX_PER_MINUTE: '2' }
      const intent = { sessionId, chatId: 'chat@c.us', waitedMs: 0 }
      const before = build(env)
      await before.admit(intent)
      await before.admit(intent)

      const after = await build(env).admit(intent)

      expect(after).toMatchObject({ decision: 'delay', rule: 'session_per_minute' })
    })

    it('blocks a chat that never wrote while cold sends are off', async () => {
      const sessionId = await newSession('cold')

      const decision = await build().admit({ sessionId, chatId: 'new@c.us', waitedMs: 0 })

      expect(decision).toMatchObject({ decision: 'reject', rule: 'cold_sends_disabled' })
    })

    it('rejects a chat on the suppression list', async () => {
      const sessionId = await newSession('suppressed')
      await stored(sessionId, 'in1')
      await suppressions.add({ sessionId, chatId: 'chat@c.us', reason: 'manual' })

      const decision = await build().check({ sessionId, chatId: 'chat@c.us', waitedMs: 0 })

      expect(decision).toMatchObject({ decision: 'reject', code: 'RECIPIENT_SUPPRESSED' })
    })

    it('flags a silent chat with 5 undelivered messages, and clears it when the contact writes', async () => {
      const sessionId = await newSession('unreachable')
      const policy = build({ ALLOW_COLD_SENDS: 'true' })
      const changes: boolean[] = []
      policy.onReachabilityChange(change => changes.push(change.unreachable))
      const oldDate = new Date(Date.now() - 100 * HOUR)
      await stored(sessionId, 'old-in', { sentAt: oldDate, receivedAt: oldDate })
      for (const [index, hours] of [10, 20, 40, 60, 80].entries()) {
        await stored(sessionId, `out${index}`, {
          direction: 'out',
          fromMe: true,
          ack: 1,
          sentAt: new Date(Date.now() - hours * HOUR)
        })
      }
      const intent = { sessionId, chatId: 'chat@c.us', waitedMs: 0 }

      expect(await policy.check(intent)).toMatchObject({ code: 'RECIPIENT_UNREACHABLE' })
      expect(await policy.check(intent)).toMatchObject({ code: 'RECIPIENT_UNREACHABLE' })
      await stored(sessionId, 'new-in')
      await policy.handleIncoming(sessionId, 'chat@c.us', 'hola')

      expect(await policy.check(intent)).toEqual({ decision: 'allow' })
      expect(changes).toEqual([true, false])
    })

    it('starts a session with an unreadable saved state throttled, not full', async () => {
      const sessionId = await newSession('unreadable')
      await stored(sessionId, 'in1')
      await redis.client.set(`policy:state:${sessionId}`, '{broken')
      const policy = build({ SESSION_MAX_PER_MINUTE: '20', PER_CHAT_MAX_PER_MINUTE: '60' })
      let allowed = 0
      for (let i = 0; i < 30; i++) {
        const decision = await policy.admit({ sessionId, chatId: 'chat@c.us', waitedMs: 0 })
        if (decision.decision !== 'allow') break
        allowed++
      }

      expect(allowed).toBe(10)
      expect((await store.load(sessionId))?.degradedUntil).toBeGreaterThan(Date.now())
    })

    it('resumes a health throttle after a restart', async () => {
      const sessionId = await newSession('health')
      await stored(sessionId, 'in1')
      const env = { HEALTH_WINDOW: '10', SESSION_MAX_PER_MINUTE: '20' }
      const before = build(env)
      await before.admit({ sessionId, chatId: 'chat@c.us', waitedMs: 0 })
      for (let i = 0; i < 7; i++) await before.recordOutcome(sessionId, 'ok')
      for (let i = 0; i < 3; i++) await before.recordOutcome(sessionId, 'hard_failure')

      expect((await store.load(sessionId))?.degradedUntil).toBeGreaterThan(Date.now())
      const after = build(env)
      let allowed = 0
      for (let i = 0; i < 30; i++) {
        const decision = await after.admit({ sessionId, chatId: `c${i}@c.us`, waitedMs: 0 })
        if (decision.decision !== 'allow') break
        allowed++
      }
      // Halved to 10, and the first send above already used one
      expect(allowed).toBeLessThanOrEqual(10)
    })
  })
})
