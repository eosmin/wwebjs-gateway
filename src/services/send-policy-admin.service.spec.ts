import { AppError, NotFoundError, ValidationError } from '../common/errors.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { SuppressionsRepository } from '../database/repositories/suppressions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { EventPipelineService } from '../whatsapp/event-pipeline.service.js'

import type { RecipientResolverService } from './recipient-resolver.service.js'
import { SendPolicyAdminService } from './send-policy-admin.service.js'
import { PolicyUnavailable, type SendPolicyService } from './send-policy.service.js'
import type { PolicyStateStore } from './send-policy.store.js'

// The service only asks whether an error is a foreign key violation; `db-errors.spec.ts` covers the
// check on real Prisma errors, which only `src/database` may build
jest.mock('../database/db-errors.js', () => ({
  isForeignKeyViolation: (error: unknown) => error instanceof Error && error.message === 'fk'
}))

const LIMITS = {
  allowColdSends: false,
  coldSendsPerDay: 20,
  coldSendMinGapMs: 1,
  lookupsPerDay: 100,
  perChatMinIntervalMs: 1,
  perChatMaxPerMinute: 6,
  sessionMaxPerMinute: 20,
  sessionMaxPerHour: 300,
  sessionMaxPerDay: 1500,
  optOutKeywords: ['stop'],
  quietHours: undefined
}

const ROW = (settings: unknown = {}) => ({ id: 's1', settings })
const CREATED_AT = new Date('2026-10-31T12:00:00.000Z')

function setup(over: { session?: unknown; created?: boolean } = {}) {
  const sessions = {
    findById: jest.fn(() => Promise.resolve('session' in over ? over.session : ROW())),
    mergeSettings: jest.fn(() => Promise.resolve(true))
  }
  const suppressions = {
    add: jest.fn((data: { chatId: string; reason: string; note: string | null }) =>
      Promise.resolve({
        created: over.created ?? true,
        suppression: { ...data, createdAt: CREATED_AT }
      })
    ),
    remove: jest.fn(() => Promise.resolve(true)),
    list: jest.fn(() => Promise.resolve([])),
    countAll: jest.fn(() => Promise.resolve(3)),
    countOf: jest.fn(() => Promise.resolve(2))
  }
  const policy = {
    effective: jest.fn(() => Promise.resolve(LIMITS)),
    usage: jest.fn(),
    invalidateSettings: jest.fn()
  }
  const resolver = { resolve: jest.fn((_s: string, to: string) => Promise.resolve(`${to}@lid`)) }
  const pipeline = { publish: jest.fn(() => Promise.resolve()) }
  const store = { listUnreachable: jest.fn(() => Promise.resolve(['a@c.us'])) }
  const metrics = new MetricsService()
  const service = new SendPolicyAdminService(
    policy as unknown as SendPolicyService,
    sessions as unknown as SessionsRepository,
    suppressions as unknown as SuppressionsRepository,
    resolver as unknown as RecipientResolverService,
    pipeline as unknown as EventPipelineService,
    store as unknown as PolicyStateStore,
    metrics
  )
  return { service, sessions, suppressions, policy, resolver, pipeline, store, metrics }
}

describe('SendPolicyAdminService', () => {
  describe('get and put', () => {
    it('shows the effective limits with the overrides of the session', async () => {
      const { service } = setup({ session: ROW({ sendPolicy: { optOutKeywords: ['stop'] } }) })

      await expect(service.get('s1')).resolves.toEqual({
        effective: { ...LIMITS, quietHours: null },
        overrides: { optOutKeywords: ['stop'] }
      })
    })

    it('shows no overrides for a session without any or with unusable ones', async () => {
      for (const settings of [{}, { sendPolicy: { sessionMaxPerDay: 0 } }]) {
        const { service } = setup({ session: ROW(settings) })
        expect((await service.get('s1')).overrides).toEqual({})
      }
    })

    it('answers NOT_FOUND for a session that does not exist', async () => {
      const { service, policy } = setup({ session: null })
      // What the policy does for a row it cannot find
      policy.usage.mockRejectedValue(new PolicyUnavailable('settings'))

      await expect(service.get('s1')).rejects.toBeInstanceOf(NotFoundError)
      await expect(service.usage('s1')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('replaces the overrides under their own key and tells the policy to read them again', async () => {
      const { service, sessions, policy } = setup()

      await service.put('s1', { allowColdSends: true })

      expect(sessions.mergeSettings).toHaveBeenCalledWith('s1', {
        sendPolicy: { allowColdSends: true }
      })
      expect(policy.invalidateSettings).toHaveBeenCalledWith('s1')
    })

    it('answers NOT_FOUND when the session is gone, without telling the policy', async () => {
      const { service, sessions, policy } = setup()
      sessions.mergeSettings.mockResolvedValue(false)

      await expect(service.put('missing', {})).rejects.toBeInstanceOf(NotFoundError)
      expect(policy.invalidateSettings).not.toHaveBeenCalled()
    })

    it('answers INTERNAL when the limits cannot be read', async () => {
      const { service, policy } = setup()
      policy.effective.mockRejectedValue(new PolicyUnavailable('settings'))

      await expect(service.get('s1')).rejects.toMatchObject({ code: 'INTERNAL' })
    })
  })

  describe('usage', () => {
    it('turns the times into ISO dates and adds the suppressed chats', async () => {
      const { service, policy } = setup()
      policy.usage.mockResolvedValue({
        at: CREATED_AT.getTime(),
        factor: 1,
        warmup: { factor: 1, linkedAt: CREATED_AT, days: 14 },
        throttle: { active: true, until: CREATED_AT.getTime() + 1000 },
        health: { samples: 0, hardFailures: 0, maxBadRatio: 0.3, minSamples: 10 },
        coldSends: { used: 0, limit: 20 },
        lookups: { used: 0, limit: 100 },
        buckets: {
          perMinute: { available: 1, limit: 1 },
          perHour: { available: 1, limit: 1 },
          perDay: { available: 1, limit: 1 }
        }
      })

      const usage = await service.usage('s1')

      expect(usage).toMatchObject({
        at: '2026-10-31T12:00:00.000Z',
        warmup: { linkedAt: '2026-10-31T12:00:00.000Z' },
        throttle: { active: true, until: '2026-10-31T12:00:01.000Z' },
        suppressedChats: 2
      })
    })

    it('answers INTERNAL when the state cannot be read', async () => {
      const { service, policy } = setup()
      policy.usage.mockRejectedValue(new PolicyUnavailable('state'))

      await expect(service.usage('s1')).rejects.toBeInstanceOf(AppError)
    })

    it('does not read the session row itself when the policy answers', async () => {
      const { service, policy, sessions } = setup()
      policy.usage.mockResolvedValue({
        at: CREATED_AT.getTime(),
        factor: 1,
        warmup: { factor: 1, linkedAt: null, days: 14 },
        throttle: { active: false, until: null },
        health: { samples: 0, hardFailures: 0, maxBadRatio: 0.3, minSamples: 10 },
        coldSends: { used: 0, limit: 20 },
        lookups: { used: 0, limit: 100 },
        buckets: {
          perMinute: { available: 1, limit: 1 },
          perHour: { available: 1, limit: 1 },
          perDay: { available: 1, limit: 1 }
        }
      })

      await service.usage('s1')

      expect(sessions.findById).not.toHaveBeenCalled()
    })

    it('answers NOT_FOUND, not INTERNAL, when the policy cannot answer for a session that is gone', async () => {
      const { service, policy } = setup({ session: null })
      policy.usage.mockRejectedValue(new PolicyUnavailable('settings'))

      await expect(service.usage('s1')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('suppressions', () => {
    it('adds the id the sends use, publishes chat_suppressed and refreshes the gauge', async () => {
      const { service, suppressions, resolver, pipeline, metrics } = setup()

      const added = await service.addSuppression('s1', '5215500000001', 'asked')

      expect(resolver.resolve).toHaveBeenCalledWith('s1', '5215500000001')
      expect(suppressions.add).toHaveBeenCalledWith({
        sessionId: 's1',
        chatId: '5215500000001@lid',
        reason: 'manual',
        note: 'asked'
      })
      expect(added).toEqual({
        chatId: '5215500000001@lid',
        reason: 'manual',
        note: 'asked',
        createdAt: '2026-10-31T12:00:00.000Z',
        created: true
      })
      expect(pipeline.publish).toHaveBeenCalledWith('s1', 'chat_suppressed', {
        chatId: '5215500000001@lid',
        reason: 'manual'
      })
      expect(await metrics.scrape()).toContain('gw_suppressed_chats 3')
    })

    it('publishes nothing for a chat that was already listed', async () => {
      const { service, pipeline } = setup({ created: false })

      expect((await service.addSuppression('s1', 'a@c.us', undefined)).created).toBe(false)
      expect(pipeline.publish).not.toHaveBeenCalled()
    })

    it('keeps the entry when the event cannot be published', async () => {
      const { service, pipeline } = setup()
      pipeline.publish.mockRejectedValue(new Error('redis down'))

      await expect(service.addSuppression('s1', 'a@c.us', undefined)).resolves.toMatchObject({
        created: true
      })
    })

    it('adds nothing for a session that does not exist', async () => {
      const { service, suppressions } = setup({ session: null })

      await expect(service.addSuppression('s1', 'a@c.us', undefined)).rejects.toBeInstanceOf(
        NotFoundError
      )
      expect(suppressions.add).not.toHaveBeenCalled()
    })

    it('answers NOT_FOUND when the session is deleted during the number look-up', async () => {
      const { service, suppressions } = setup()
      suppressions.add.mockRejectedValue(new Error('fk'))

      await expect(service.addSuppression('s1', 'a@c.us', undefined)).rejects.toBeInstanceOf(
        NotFoundError
      )
    })

    it('does not hide any other failure of the write', async () => {
      const { service, suppressions } = setup()
      suppressions.add.mockRejectedValue(new Error('db down'))

      await expect(service.addSuppression('s1', 'a@c.us', undefined)).rejects.toThrow('db down')
    })

    it('removes a chat, and answers NOT_FOUND for one that is not listed', async () => {
      const { service, suppressions } = setup()
      await service.removeSuppression('s1', 'a@c.us')

      suppressions.remove.mockResolvedValue(false)
      await expect(service.removeSuppression('s1', 'a@c.us')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('lists the entries with ISO dates', async () => {
      const { service, suppressions } = setup()
      suppressions.list.mockResolvedValue([
        { chatId: 'a@c.us', reason: 'opt_out', note: null, createdAt: CREATED_AT }
      ] as never)

      await expect(service.listSuppressions('s1', { limit: 100 })).resolves.toEqual({
        items: [
          { chatId: 'a@c.us', reason: 'opt_out', note: null, createdAt: '2026-10-31T12:00:00.000Z' }
        ],
        nextCursor: null
      })
      expect(suppressions.list).toHaveBeenCalledWith('s1', 101, undefined)
    })

    it('gives a cursor when there is another page and continues from it', async () => {
      const { service, suppressions } = setup()
      const row = (chatId: string) => ({
        chatId,
        reason: 'manual',
        note: null,
        createdAt: CREATED_AT
      })
      suppressions.list.mockResolvedValueOnce([
        row('c@c.us'),
        row('b@c.us'),
        row('a@c.us')
      ] as never)

      const first = await service.listSuppressions('s1', { limit: 2 })

      expect(first.items.map(item => item.chatId)).toEqual(['c@c.us', 'b@c.us'])
      expect(first.nextCursor).not.toBeNull()

      suppressions.list.mockResolvedValueOnce([row('a@c.us')] as never)
      const second = await service.listSuppressions('s1', {
        limit: 2,
        cursor: first.nextCursor ?? ''
      })

      expect(suppressions.list).toHaveBeenLastCalledWith('s1', 3, {
        createdAt: CREATED_AT,
        chatId: 'b@c.us'
      })
      expect(second).toMatchObject({ items: [{ chatId: 'a@c.us' }], nextCursor: null })
    })

    it('refuses a cursor that is not one of ours, before listing anything', async () => {
      const { service, suppressions } = setup()

      await expect(
        service.listSuppressions('s1', { limit: 10, cursor: 'not-a-cursor' })
      ).rejects.toBeInstanceOf(ValidationError)
      expect(suppressions.list).not.toHaveBeenCalled()
    })
  })

  describe('unreachable chats', () => {
    it('lists the flagged chats', async () => {
      const { service } = setup()

      await expect(service.unreachableChats('s1')).resolves.toEqual({
        items: [{ chatId: 'a@c.us' }],
        truncated: false
      })
    })

    it('says when there are more than it lists', async () => {
      const { service, store } = setup()
      store.listUnreachable.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => `${i}@c.us`))

      const result = await service.unreachableChats('s1')

      expect(result.items).toHaveLength(1000)
      expect(result.truncated).toBe(true)
    })

    it('answers INTERNAL when the store fails', async () => {
      const { service, store } = setup()
      store.listUnreachable.mockRejectedValue(new Error('redis down'))

      await expect(service.unreachableChats('s1')).rejects.toMatchObject({ code: 'INTERNAL' })
    })
  })
})
