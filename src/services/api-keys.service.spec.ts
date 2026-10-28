import type { AppConfig } from '../config/env.schema.js'
import type { ApiKey } from '../database/models.js'
import type { NewApiKey, ApiKeysRepository } from '../database/repositories/api-keys.repository.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'

import { ApiKeysService } from './api-keys.service.js'
import type { AuthService } from './auth.service.js'

const DAY = 86_400_000

function row(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10',
    name: 'bot',
    keyHash: 'hash',
    keyPrefix: 'wgk_Ab3d',
    sessionId: 'main',
    scopes: ['read'],
    allowedCidrs: ['10.0.0.0/8'],
    expiresAt: null,
    rotatedFromId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides
  }
}

function setup(config: Partial<AppConfig> = {}) {
  // What the transaction would read: null = missing, a revoked row is not rotated
  const state: { stored: ApiKey | null } = { stored: null }
  const apiKeys = {
    create: jest.fn<Promise<ApiKey | null>, [NewApiKey]>((data: NewApiKey) =>
      Promise.resolve(row({ ...data, id: 'new-id' }))
    ),
    rotate: jest.fn<Promise<ApiKey | null>, [string, (old: ApiKey) => NewApiKey, Date]>(
      (_id, build) => {
        const old = state.stored
        if (old === null || old.revokedAt !== null) return Promise.resolve(null)
        return Promise.resolve(row({ ...build(old), id: 'new-id' }))
      }
    ),
    revoke: jest.fn<Promise<ApiKey | null>, [string, Date]>(),
    list: jest.fn<Promise<ApiKey[]>, []>()
  }
  const sessions = { findById: jest.fn().mockResolvedValue({ id: 'main' }) }
  const auth = { invalidate: jest.fn() }
  const service = new ApiKeysService(
    { API_KEY_ROTATION_GRACE_MINUTES: 10, API_KEY_MAX_TTL_DAYS: 0, ...config } as AppConfig, // reason: only these two fields are read
    apiKeys as unknown as ApiKeysRepository, // reason: the fake implements the methods the service calls
    sessions as unknown as SessionsRepository, // reason: same
    auth as unknown as AuthService // reason: same
  )
  return { service, apiKeys, state, sessions, auth }
}

describe('ApiKeysService.create', () => {
  it('stores the hash, never the raw key, and returns the raw key', async () => {
    const { service, apiKeys } = setup()

    const created = await service.create({ name: 'bot', sessionId: 'main' })

    const stored = apiKeys.create.mock.calls[0]?.[0]
    expect(created.key).toMatch(/^wgk_/)
    expect(stored?.keyHash).toHaveLength(64)
    expect(JSON.stringify(stored)).not.toContain(created.key)
  })

  it('gives an admin key every scope and a session key the default ones', async () => {
    const { service, apiKeys } = setup()

    await service.create({ name: 'ops' })
    await service.create({ name: 'bot', sessionId: 'main' })

    expect(apiKeys.create.mock.calls[0]?.[0].scopes).toEqual([
      'read',
      'send',
      'manage',
      'webhooks',
      'events'
    ])
    expect(apiKeys.create.mock.calls[1]?.[0].scopes).toEqual(['read', 'send', 'events'])
  })

  it('refuses scopes on a key without a session instead of promoting it', async () => {
    const { service, apiKeys } = setup()

    await expect(service.create({ name: 'ops', scopes: ['read'] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
    expect(apiKeys.create).not.toHaveBeenCalled()
  })

  it('answers NOT_FOUND when the session is deleted before the key is written', async () => {
    const { service, apiKeys } = setup()
    apiKeys.create.mockResolvedValue(null)

    await expect(service.create({ name: 'bot', sessionId: 'main' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('lets any other write failure through', async () => {
    const { service, apiKeys } = setup()
    apiKeys.create.mockRejectedValue(new Error('disk full'))

    await expect(service.create({ name: 'bot' })).rejects.toThrow('disk full')
  })

  it('refuses a session that does not exist', async () => {
    const { service, sessions } = setup()
    sessions.findById.mockResolvedValue(null)

    await expect(service.create({ name: 'bot', sessionId: 'ghost' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  describe('with API_KEY_MAX_TTL_DAYS set', () => {
    it('gives a key without an expiry the longest one allowed', async () => {
      const { service } = setup({ API_KEY_MAX_TTL_DAYS: 30 })

      const created = await service.create({ name: 'bot' })

      const days = (new Date(created.expiresAt ?? 0).getTime() - Date.now()) / DAY
      expect(days).toBeGreaterThan(29.99)
      expect(days).toBeLessThanOrEqual(30)
    })

    it('refuses an expiry beyond the cap instead of shortening it', async () => {
      const { service } = setup({ API_KEY_MAX_TTL_DAYS: 30 })
      const expiresAt = new Date(Date.now() + 31 * DAY).toISOString()

      await expect(service.create({ name: 'bot', expiresAt })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
    })

    it('accepts an expiry inside the cap', async () => {
      const { service } = setup({ API_KEY_MAX_TTL_DAYS: 30 })
      const expiresAt = new Date(Date.now() + 5 * DAY).toISOString()

      expect((await service.create({ name: 'bot', expiresAt })).expiresAt).toBe(expiresAt)
    })
  })

  it('leaves a key without an expiry open-ended when there is no cap', async () => {
    const { service } = setup()

    expect((await service.create({ name: 'bot' })).expiresAt).toBeNull()
  })
})

describe('ApiKeysService.rotate', () => {
  // The replacement the repository was asked to write, built from the row it read
  const built = ({ apiKeys, state }: ReturnType<typeof setup>): NewApiKey => {
    const build = apiKeys.rotate.mock.calls[0]?.[1]
    if (build === undefined || state.stored === null) throw new Error('no rotation happened')
    return build(state.stored)
  }

  it('copies name, session, scopes and addresses and ends the old key after the grace period', async () => {
    const ctx = setup()
    const { service, apiKeys, state, auth } = ctx
    const old = row()
    state.stored = old

    const rotated = await service.rotate(old.id)

    const graceEnd = apiKeys.rotate.mock.calls[0]?.[2] ?? new Date(0)
    expect(apiKeys.rotate.mock.calls[0]?.[0]).toBe(old.id)
    expect(built(ctx)).toMatchObject({
      name: 'bot',
      sessionId: 'main',
      scopes: ['read'],
      allowedCidrs: ['10.0.0.0/8']
    })
    expect(graceEnd.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000)
    expect(rotated.previousKeyExpiresAt).toBe(graceEnd.toISOString())
    expect(auth.invalidate).toHaveBeenCalledWith(old.id)
  })

  it('reports the earlier date when the old key expires before the grace period ends', async () => {
    const ctx = setup()
    const { service, state } = ctx
    const soon = new Date(Date.now() + 60_000)
    state.stored = row({ expiresAt: soon })

    expect((await service.rotate('id')).previousKeyExpiresAt).toBe(soon.toISOString())
  })

  it('carries an expiry still ahead to the new key', async () => {
    const ctx = setup()
    const { service, state } = ctx
    const ahead = new Date(Date.now() + 5 * DAY)
    state.stored = row({ expiresAt: ahead })

    await service.rotate('id')

    expect(built(ctx).expiresAt).toEqual(ahead)
  })

  it('ends the old key exactly one grace period from now, in minutes', async () => {
    const ctx = setup({ API_KEY_ROTATION_GRACE_MINUTES: 7 })
    ctx.state.stored = row()
    const before = Date.now()

    const rotated = await ctx.service.rotate('id')

    const ms = new Date(rotated.previousKeyExpiresAt).getTime() - before
    expect(ms).toBeGreaterThanOrEqual(7 * 60_000)
    expect(ms).toBeLessThan(7 * 60_000 + 5_000)
  })

  it('leaves the new key of a key without an expiry open-ended when there is no cap', async () => {
    const ctx = setup()
    ctx.state.stored = row({ expiresAt: null })

    await ctx.service.rotate('id')

    expect(built(ctx).expiresAt).toBeNull()
  })

  it('gives the new key of a key without an expiry the cap', async () => {
    const ctx = setup({ API_KEY_MAX_TTL_DAYS: 30 })
    ctx.state.stored = row({ expiresAt: null })

    await ctx.service.rotate('id')

    const days = ((built(ctx).expiresAt?.getTime() ?? 0) - Date.now()) / DAY
    expect(days).toBeGreaterThan(29.99)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('does not carry an expiry beyond the cap in force now', async () => {
    const ctx = setup({ API_KEY_MAX_TTL_DAYS: 30 })
    const { service, state } = ctx
    state.stored = row({ expiresAt: new Date(Date.now() + 365 * DAY) })

    await service.rotate('id')

    const days = ((built(ctx).expiresAt?.getTime() ?? 0) - Date.now()) / DAY
    expect(days).toBeGreaterThan(29.99)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('gives the new key of a lapsed one the cap instead of a date in the past', async () => {
    const ctx = setup({ API_KEY_MAX_TTL_DAYS: 30 })
    const { service, state } = ctx
    state.stored = row({ expiresAt: new Date(Date.now() - DAY) })

    await service.rotate('id')

    expect(built(ctx).expiresAt?.getTime()).toBeGreaterThan(Date.now())
  })

  it.each([
    ['is missing', null],
    ['is revoked', row({ revokedAt: new Date() })]
  ])('answers NOT_FOUND when the key %s', async (_label, found) => {
    const ctx = setup()
    const { service, state, auth } = ctx
    state.stored = found

    await expect(service.rotate('id')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(auth.invalidate).not.toHaveBeenCalled()
  })
})

describe('ApiKeysService.revoke', () => {
  it('drops the key from the auth cache', async () => {
    const { service, apiKeys, auth } = setup()
    apiKeys.revoke.mockResolvedValue(row({ revokedAt: new Date() }))

    await service.revoke('id')

    expect(auth.invalidate).toHaveBeenCalledWith('id')
  })

  it('answers NOT_FOUND for a key that does not exist', async () => {
    const { service, apiKeys, auth } = setup()
    apiKeys.revoke.mockResolvedValue(null)

    await expect(service.revoke('id')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(auth.invalidate).not.toHaveBeenCalled()
  })
})
