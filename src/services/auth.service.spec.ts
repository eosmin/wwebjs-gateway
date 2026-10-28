import { Logger } from '@nestjs/common'

import { generateApiKey } from '../common/lib/crypto.js'
import type { AppConfig } from '../config/env.schema.js'
import type { ApiKey } from '../database/models.js'
import type { ApiKeysRepository } from '../database/repositories/api-keys.repository.js'

import { AuthService } from './auth.service.js'

const ADMIN_KEY = 'a'.repeat(32)
const NOW = new Date('2026-10-28T12:00:00Z')

function row(overrides: Partial<ApiKey> & { keyHash: string }): ApiKey {
  return {
    id: 'key-1',
    name: 'plugin',
    keyPrefix: 'wgk_abcd',
    sessionId: 'shop',
    scopes: ['read', 'send'],
    allowedCidrs: [],
    expiresAt: null,
    rotatedFromId: null,
    createdAt: NOW,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides
  }
}

function setup(rows: ApiKey[]) {
  const findByHash = jest.fn((hash: string) =>
    Promise.resolve(rows.find(candidate => candidate.keyHash === hash) ?? null)
  )
  const touchLastUsed = jest.fn(() => Promise.resolve())
  const repository = { findByHash, touchLastUsed } as unknown as ApiKeysRepository
  const config = { ADMIN_API_KEY: ADMIN_KEY } as AppConfig
  return { service: new AuthService(config, repository), findByHash, touchLastUsed, rows }
}

describe('AuthService.authenticate', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('accepts the environment key as an admin without touching the database', async () => {
    const { service, findByHash } = setup([])

    const principal = await service.authenticate(ADMIN_KEY, '203.0.113.1')

    expect(principal).toMatchObject({ keyId: null, isAdmin: true, sessionId: null })
    expect(findByHash).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'wgk_unknown'])('answers UNAUTHORIZED for %j', async key => {
    const { service } = setup([])

    await expect(service.authenticate(key, '203.0.113.1')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401
    })
  })

  it('resolves a database key to a principal limited to its session and scopes', async () => {
    const generated = generateApiKey()
    const { service } = setup([row({ keyHash: generated.hash })])

    const principal = await service.authenticate(generated.raw, '203.0.113.1')

    expect(principal).toMatchObject({ keyId: 'key-1', isAdmin: false, sessionId: 'shop' })
    expect([...principal.scopes]).toEqual(['read', 'send'])
  })

  it('treats a database key without a session as an admin key', async () => {
    const generated = generateApiKey()
    const { service } = setup([row({ keyHash: generated.hash, sessionId: null })])

    await expect(service.authenticate(generated.raw, '203.0.113.1')).resolves.toMatchObject({
      isAdmin: true
    })
  })

  it('rejects a revoked key', async () => {
    const generated = generateApiKey()
    const { service } = setup([row({ keyHash: generated.hash, revokedAt: NOW })])

    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })

  it('answers API_KEY_EXPIRED once the expiry has passed, and not before', async () => {
    const generated = generateApiKey()
    const expiresAt = new Date(NOW.getTime() + 1000)
    const { service } = setup([row({ keyHash: generated.hash, expiresAt })])

    await expect(service.authenticate(generated.raw, '203.0.113.1')).resolves.toBeDefined()
    jest.setSystemTime(expiresAt)

    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'API_KEY_EXPIRED',
      status: 401
    })
  })

  it('answers IP_NOT_ALLOWED outside the allowed CIDRs and accepts inside them', async () => {
    const generated = generateApiKey()
    const { service } = setup([row({ keyHash: generated.hash, allowedCidrs: ['10.0.0.0/8'] })])

    await expect(service.authenticate(generated.raw, '10.4.5.6')).resolves.toBeDefined()
    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'IP_NOT_ALLOWED',
      status: 403
    })
  })

  it('denies when the address is unknown and the key has an allowlist', async () => {
    const generated = generateApiKey()
    const { service } = setup([row({ keyHash: generated.hash, allowedCidrs: ['10.0.0.0/8'] })])

    await expect(service.authenticate(generated.raw, '')).rejects.toMatchObject({
      code: 'IP_NOT_ALLOWED'
    })
  })

  it('rejects a near miss of the environment key', async () => {
    const { service } = setup([])

    await expect(service.authenticate(`${'a'.repeat(31)}b`, 'x')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
    await expect(service.authenticate('a'.repeat(31), 'x')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })

  it('reports an expired key before the address, and a revoked one before expiry', async () => {
    const expired = generateApiKey()
    const both = generateApiKey()
    const past = new Date(NOW.getTime() - 1000)
    const { service } = setup([
      row({ keyHash: expired.hash, expiresAt: past, allowedCidrs: ['10.0.0.0/8'] }),
      row({ id: 'key-2', keyHash: both.hash, expiresAt: past, revokedAt: NOW })
    ])

    await expect(service.authenticate(expired.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'API_KEY_EXPIRED'
    })
    await expect(service.authenticate(both.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })

  it('denies every address when the allowlist is entirely corrupt', async () => {
    const generated = generateApiKey()
    const { service } = setup([row({ keyHash: generated.hash, allowedCidrs: ['nope'] })])

    await expect(service.authenticate(generated.raw, '10.0.0.1')).rejects.toMatchObject({
      code: 'IP_NOT_ALLOWED'
    })
  })

  it('does not make a keyed session admin because its row lists the admin scope', async () => {
    const generated = generateApiKey()
    const { service } = setup([row({ keyHash: generated.hash, scopes: ['read', 'admin'] })])

    const principal = await service.authenticate(generated.raw, '203.0.113.1')

    expect(principal.isAdmin).toBe(false)
    expect(principal.scopes.has('admin')).toBe(false)
  })

  it('does not apply an address list to the environment key', async () => {
    const { service } = setup([])

    await expect(service.authenticate(ADMIN_KEY, '')).resolves.toBeDefined()
  })
})

describe('AuthService cache', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('reads the row once within the TTL, then again after it', async () => {
    const generated = generateApiKey()
    const { service, findByHash } = setup([row({ keyHash: generated.hash })])

    await service.authenticate(generated.raw, '203.0.113.1')
    await service.authenticate(generated.raw, '203.0.113.1')
    expect(findByHash).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(30_001)
    await service.authenticate(generated.raw, '203.0.113.1')
    expect(findByHash).toHaveBeenCalledTimes(2)
  })

  it('stops a revoked key at once after invalidate, not after the TTL', async () => {
    const generated = generateApiKey()
    const { service, rows } = setup([row({ keyHash: generated.hash })])
    await service.authenticate(generated.raw, '203.0.113.1')

    rows[0] = row({ keyHash: generated.hash, revokedAt: NOW })
    await expect(service.authenticate(generated.raw, '203.0.113.1')).resolves.toBeDefined()
    service.invalidate('key-1')

    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })

  it('does not cache a row that was read before an invalidate and arrived after it', async () => {
    const generated = generateApiKey()
    const { service, findByHash, rows } = setup([row({ keyHash: generated.hash })])
    let release: () => void = () => undefined
    const stale = row({ keyHash: generated.hash })
    findByHash.mockImplementationOnce(
      () =>
        new Promise<ApiKey | null>(resolve => {
          release = () => {
            resolve(stale)
          }
        })
    )

    const pending = service.authenticate(generated.raw, '203.0.113.1')
    service.invalidate('key-1')
    rows[0] = row({ keyHash: generated.hash, revokedAt: NOW })
    release()
    await pending

    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })

  it('keeps serving the cached row when another key is invalidated', async () => {
    const generated = generateApiKey()
    const { service, rows } = setup([row({ keyHash: generated.hash })])
    await service.authenticate(generated.raw, '203.0.113.1')

    rows[0] = row({ keyHash: generated.hash, revokedAt: NOW })
    service.invalidate('other-key')

    await expect(service.authenticate(generated.raw, '203.0.113.1')).resolves.toBeDefined()
  })

  it('rejects a revoked key once the TTL passes even without an invalidate', async () => {
    const generated = generateApiKey()
    const { service, rows } = setup([row({ keyHash: generated.hash })])
    await service.authenticate(generated.raw, '203.0.113.1')

    rows[0] = row({ keyHash: generated.hash, revokedAt: NOW })
    jest.advanceTimersByTime(30_001)

    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })

  it('does not cache an unknown key', async () => {
    const { service, findByHash } = setup([])

    await expect(service.authenticate('wgk_unknown', 'x')).rejects.toBeDefined()
    await expect(service.authenticate('wgk_unknown', 'x')).rejects.toBeDefined()

    expect(findByHash).toHaveBeenCalledTimes(2)
  })
})

describe('AuthService last use', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('stamps a key at most once a minute', async () => {
    const generated = generateApiKey()
    const { service, touchLastUsed } = setup([row({ keyHash: generated.hash })])

    await service.authenticate(generated.raw, '203.0.113.1')
    await service.authenticate(generated.raw, '203.0.113.1')
    expect(touchLastUsed).toHaveBeenCalledTimes(1)
    expect(touchLastUsed).toHaveBeenCalledWith('key-1', NOW)

    jest.advanceTimersByTime(59_999)
    await service.authenticate(generated.raw, '203.0.113.1')
    expect(touchLastUsed).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(1)
    await service.authenticate(generated.raw, '203.0.113.1')
    expect(touchLastUsed).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['expired', { expiresAt: new Date(NOW.getTime() - 1) }],
    ['revoked', { revokedAt: NOW }]
  ])('does not stamp an %s key', async (_name, overrides) => {
    const generated = generateApiKey()
    const { service, touchLastUsed } = setup([row({ keyHash: generated.hash, ...overrides })])

    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toBeDefined()

    expect(touchLastUsed).not.toHaveBeenCalled()
  })

  it('does not stamp a rejected request', async () => {
    const generated = generateApiKey()
    const { service, touchLastUsed } = setup([
      row({ keyHash: generated.hash, allowedCidrs: ['10.0.0.0/8'] })
    ])

    await expect(service.authenticate(generated.raw, '203.0.113.1')).rejects.toBeDefined()

    expect(touchLastUsed).not.toHaveBeenCalled()
  })

  it('lets the request succeed when the stamp fails', async () => {
    const generated = generateApiKey()
    const { service, touchLastUsed } = setup([row({ keyHash: generated.hash })])
    touchLastUsed.mockRejectedValueOnce(new Error('db down'))
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()

    await expect(service.authenticate(generated.raw, '203.0.113.1')).resolves.toBeDefined()
    await jest.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('last use'))
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('db down')
  })
})
