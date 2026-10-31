import { AppError, UnprocessableError, ValidationError } from '../common/errors.js'
import type { RedisService } from '../infra/redis/redis.service.js'
import type { PolicyDecision } from '../types/send-policy.dto.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { RecipientResolverService } from './recipient-resolver.service.js'
import type { SendPolicyService } from './send-policy.service.js'

function build(options: { registered?: string | null; lookup?: PolicyDecision } = {}) {
  const store = new Map<string, string>()
  const getNumberId = jest.fn(() => Promise.resolve(options.registered ?? null))
  const requireReady = jest.fn(() => ({ getNumberId }) as unknown as WhatsAppClientPort)
  const admitLookup = jest.fn(() =>
    Promise.resolve(options.lookup ?? { decision: 'allow' as const })
  )
  const redis = {
    client: {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve('OK')
      })
    }
  }
  const service = new RecipientResolverService(
    { requireReady } as unknown as SessionManager,
    { admitLookup } as unknown as SendPolicyService,
    redis as unknown as RedisService
  )
  return { service, getNumberId, admitLookup, requireReady, redis }
}

describe('RecipientResolverService', () => {
  it('uses a WhatsApp id as it is, without a look-up', async () => {
    const { service, getNumberId, requireReady } = build()

    await expect(service.resolve('s', '120363000000000000@g.us')).resolves.toBe(
      '120363000000000000@g.us'
    )
    expect(getNumberId).not.toHaveBeenCalled()
    expect(requireReady).not.toHaveBeenCalled()
  })

  it('looks a phone number up, tolerating spaces and a plus, and caches the answer', async () => {
    const { service, getNumberId, redis } = build({ registered: '5215500000001@c.us' })

    await expect(service.resolve('s', '+52 55-0000-0001')).resolves.toBe('5215500000001@c.us')
    await expect(service.resolve('other-session', '525500000001')).resolves.toBe(
      '5215500000001@c.us'
    )

    expect(getNumberId).toHaveBeenCalledTimes(1)
    expect(getNumberId).toHaveBeenCalledWith('525500000001')
    expect(redis.client.set).toHaveBeenCalledWith(
      'numid:525500000001',
      '5215500000001@c.us',
      'EX',
      3600
    )
  })

  it('answers NUMBER_NOT_ON_WHATSAPP, and remembers it for the hour', async () => {
    const { service, getNumberId } = build({ registered: null })

    await expect(service.resolve('s', '525500000009')).rejects.toBeInstanceOf(UnprocessableError)
    await expect(service.resolve('s', '525500000009')).rejects.toMatchObject({
      code: 'NUMBER_NOT_ON_WHATSAPP'
    })
    expect(getNumberId).toHaveBeenCalledTimes(1)
  })

  it('keeps a "not on WhatsApp" for minutes, not an hour, and does not repeat the number', async () => {
    const { service, redis } = build({ registered: null })

    const error = await service.resolve('s', '525500000009').catch((e: unknown) => e)

    expect(redis.client.set).toHaveBeenCalledWith('numid:525500000009', '', 'EX', 300)
    expect(error).toMatchObject({ code: 'NUMBER_NOT_ON_WHATSAPP' })
    expect(JSON.stringify(error)).not.toContain('525500000009')
    expect((error as Error).message).not.toContain('525500000009')
  })

  it('looks a number up again when the cache holds something that is not an id', async () => {
    const { service, getNumberId, redis } = build({ registered: '5215500000001@c.us' })
    await redis.client.set('numid:525500000001', 'garbage value')

    await expect(service.resolve('s', '525500000001')).resolves.toBe('5215500000001@c.us')
    expect(getNumberId).toHaveBeenCalledTimes(1)
  })

  it('takes a @lid id as it is, and counts a delayed look-up as POLICY_BLOCKED', async () => {
    const { service } = build({
      lookup: { decision: 'delay', delayMs: 1, rule: 'SETTINGS_UNAVAILABLE' as never }
    })

    await expect(service.resolve('s', '123456@lid')).resolves.toBe('123456@lid')
    await expect(service.resolve('s', '525500000001')).rejects.toMatchObject({
      code: 'POLICY_BLOCKED'
    })
  })

  it('stops at the look-up budget before asking WhatsApp', async () => {
    const { service, getNumberId } = build({
      lookup: { decision: 'reject', code: 'POLICY_BLOCKED', rule: 'LOOKUPS_PER_DAY' as never }
    })

    await expect(service.resolve('s', '525500000001')).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      details: { rule: 'LOOKUPS_PER_DAY' }
    })
    expect(getNumberId).not.toHaveBeenCalled()
  })

  it('treats a delayed look-up as a refusal, because the caller is waiting', async () => {
    const { service } = build({
      lookup: { decision: 'delay', delayMs: 1000, rule: 'SETTINGS_UNAVAILABLE' as never }
    })

    await expect(service.resolve('s', '525500000001')).rejects.toBeInstanceOf(AppError)
  })

  it('lookup answers null for a number that is not registered, and the id for one that is', async () => {
    const none = build({ registered: null })
    const some = build({ registered: '5215500000001@c.us' })

    await expect(none.service.lookup('s', '525500000009')).resolves.toBeNull()
    await expect(some.service.lookup('s', '5215500000001')).resolves.toBe('5215500000001@c.us')
  })

  it('rejects a recipient that is neither', async () => {
    const { service } = build()

    await expect(service.resolve('s', 'hello')).rejects.toBeInstanceOf(ValidationError)
  })
})
