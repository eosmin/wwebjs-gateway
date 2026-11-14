import { NotFoundError, UnauthorizedError } from '../common/errors.js'
import { generateToken, sha256Hex } from '../common/lib/crypto.js'
import type { AppConfig } from '../config/env.schema.js'
import type { InboundHook } from '../database/models.js'
import type { InboundHooksRepository } from '../database/repositories/inbound-hooks.repository.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'

import { InboundHookService, toInboundHookDto } from './inbound-hook.service.js'

const ID = '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10'

function row(overrides: Partial<InboundHook> = {}): InboundHook {
  return {
    id: ID,
    sessionId: 'main',
    name: 'crisp',
    tokenHash: 'stored-hash',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    revokedAt: null,
    ...overrides
  }
}

function setup() {
  const hooks = {
    create: jest.fn<Promise<InboundHook | null>, [Record<string, string>]>(data =>
      Promise.resolve(row(data))
    ),
    findById: jest.fn<Promise<InboundHook | null>, [string]>(() => Promise.resolve(row())),
    findByTokenHash: jest.fn<Promise<InboundHook | null>, [string]>(() => Promise.resolve(row())),
    listForSession: jest.fn<Promise<InboundHook[]>, [string]>(() => Promise.resolve([row()])),
    revoke: jest.fn<Promise<InboundHook | null>, [string, Date]>((_id, at) =>
      Promise.resolve(row({ revokedAt: at }))
    )
  }
  const sessions = { findById: jest.fn(() => Promise.resolve({ id: 'main' })) }
  const service = new InboundHookService(
    { PUBLIC_BASE_URL: 'https://gw.example.test' } as AppConfig,
    hooks as unknown as InboundHooksRepository,
    sessions as unknown as SessionsRepository
  )
  return { service, hooks, sessions }
}

describe('create', () => {
  it('returns the URL with the token once and stores only the sha256 of the token', async () => {
    const { service, hooks } = setup()

    const created = await service.create('main', 'crisp')

    const token = created.url.replace('https://gw.example.test/v1/hooks/inbound/', '')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hooks.create).toHaveBeenCalledWith({
      sessionId: 'main',
      name: 'crisp',
      tokenHash: sha256Hex(token)
    })
    expect(JSON.stringify(hooks.create.mock.calls)).not.toContain(token)
    expect(created).toMatchObject({ id: ID, sessionId: 'main', name: 'crisp', revokedAt: null })
  })

  it('gives every hook a different token', async () => {
    const { service } = setup()

    const [a, b] = await Promise.all([service.create('main', 'a'), service.create('main', 'b')])

    expect(a.url).not.toBe(b.url)
  })

  it('keeps the path prefix of a gateway published behind a reverse proxy', async () => {
    const { hooks, sessions } = setup()
    const service = new InboundHookService(
      { PUBLIC_BASE_URL: 'https://gw.example.test/some/path/' } as AppConfig,
      hooks as unknown as InboundHooksRepository,
      sessions as unknown as SessionsRepository
    )

    expect((await service.create('main', 'x')).url).toMatch(
      /^https:\/\/gw\.example\.test\/some\/path\/v1\/hooks\/inbound\/[\w-]{43}$/
    )
  })

  it('answers 404 when the session does not exist, before it stores anything', async () => {
    const { service, hooks, sessions } = setup()
    sessions.findById.mockResolvedValueOnce(null as never)

    await expect(service.create('nope', 'x')).rejects.toBeInstanceOf(NotFoundError)
    expect(hooks.create).not.toHaveBeenCalled()
  })

  it('answers 404 when the session is deleted between the check and the insert', async () => {
    const { service, hooks } = setup()
    hooks.create.mockResolvedValueOnce(null)

    await expect(service.create('main', 'x')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('resolve', () => {
  it('finds the hook by the sha256 of the token', async () => {
    const { service, hooks } = setup()
    const token = generateToken()

    await expect(service.resolve(token)).resolves.toEqual({ hookId: ID, sessionId: 'main' })
    expect(hooks.findByTokenHash).toHaveBeenCalledWith(sha256Hex(token))
  })

  it('answers the same 401 for an unknown token and a revoked one', async () => {
    const { service, hooks } = setup()
    hooks.findByTokenHash.mockResolvedValueOnce(null)
    const unknown = await service.resolve(generateToken()).catch((error: unknown) => error)
    hooks.findByTokenHash.mockResolvedValueOnce(row({ revokedAt: new Date() }))
    const revoked = await service.resolve(generateToken()).catch((error: unknown) => error)

    expect(unknown).toBeInstanceOf(UnauthorizedError)
    expect(revoked).toBeInstanceOf(UnauthorizedError)
    expect((revoked as UnauthorizedError).message).toBe((unknown as UnauthorizedError).message)
    expect((revoked as UnauthorizedError).code).toBe((unknown as UnauthorizedError).code)
  })

  it.each([
    '',
    'short',
    'x'.repeat(44),
    `${'a'.repeat(42)}+`,
    `${'a'.repeat(42)}/`,
    `${'a'.repeat(42)} `
  ])('refuses %j without reading the database', async token => {
    const { service, hooks } = setup()

    await expect(service.resolve(token)).rejects.toBeInstanceOf(UnauthorizedError)
    expect(hooks.findByTokenHash).not.toHaveBeenCalled()
  })

  it('does not cache: a hook revoked after a use stops at once', async () => {
    const { service, hooks } = setup()
    const token = generateToken()

    await service.resolve(token)
    hooks.findByTokenHash.mockResolvedValueOnce(row({ revokedAt: new Date() }))

    await expect(service.resolve(token)).rejects.toBeInstanceOf(UnauthorizedError)
  })
})

describe('revoke', () => {
  it('revokes a hook of the session and answers it', async () => {
    const { service, hooks } = setup()

    const dto = await service.revoke('main', ID)

    expect(hooks.revoke).toHaveBeenCalledWith(ID, expect.any(Date))
    expect(dto.revokedAt).not.toBeNull()
  })

  it('answers 404 for a hook of another session without touching it', async () => {
    const { service, hooks } = setup()

    await expect(service.revoke('other', ID)).rejects.toBeInstanceOf(NotFoundError)
    expect(hooks.revoke).not.toHaveBeenCalled()
  })

  it('answers 404 for a hook that does not exist', async () => {
    const { service, hooks } = setup()
    hooks.findById.mockResolvedValueOnce(null)

    await expect(service.revoke('main', ID)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('answers 404 when the hook is deleted between the read and the revoke', async () => {
    const { service, hooks } = setup()
    hooks.revoke.mockResolvedValueOnce(null)

    await expect(service.revoke('main', ID)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('list and the DTO', () => {
  it('lists the hooks of the session without any token or hash', async () => {
    const { service, hooks } = setup()

    const list = await service.list('main')

    expect(hooks.listForSession).toHaveBeenCalledWith('main')
    expect(list).toEqual([toInboundHookDto(row())])
    expect(JSON.stringify(list)).not.toContain('stored-hash')
  })
})
