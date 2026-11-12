import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors.js'
import { adminPrincipal, keyPrincipal } from '../common/principal.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Webhook } from '../database/models.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { WebhooksRepository } from '../database/repositories/webhooks.repository.js'

import {
  WebhookService,
  assertCredentialEventsAllowed,
  receivesEvent,
  toWebhookDto
} from './webhook.service.js'

const ID = '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10'
const ADMIN = adminPrincipal(null)

function row(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: ID,
    sessionId: 'main',
    url: 'https://hooks.example.test/in',
    secret: 'whsec_stored',
    events: ['*'],
    enabled: true,
    mediaMode: 'reference',
    includeRaw: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides
  }
}

function setup(config: Partial<AppConfig> = {}) {
  const webhooks = {
    list: jest.fn<Promise<Webhook[]>, [string?]>(() => Promise.resolve([row()])),
    findById: jest.fn<Promise<Webhook | null>, [string]>(() => Promise.resolve(row())),
    create: jest.fn<Promise<Webhook | null>, [Record<string, unknown>]>(data =>
      Promise.resolve(row(data as Partial<Webhook>))
    ),
    // The write that only goes through while the events are the ones the check read
    updateIfEvents: jest.fn<Promise<Webhook | null>, [string, string[], Record<string, unknown>]>(
      (_id, _events, patch) => Promise.resolve(row(patch as Partial<Webhook>))
    ),
    delete: jest.fn<Promise<boolean>, [string]>(() => Promise.resolve(true)),
    listEnabledFor: jest.fn<Promise<Webhook[]>, [string]>(() => Promise.resolve([row()])),
    countFor: jest.fn<Promise<number>, [string | null]>(() => Promise.resolve(0))
  }
  const sessions = {
    findById: jest.fn(() => Promise.resolve({ id: 'main' }))
  }
  const service = new WebhookService(
    {
      // An address literal needs no DNS lookup
      WEBHOOK_PRIVATE_HOST_ALLOWLIST: [],
      ALLOW_PRIVATE_WEBHOOK_TARGETS: false,
      INCLUDE_RAW: true,
      WEBHOOKS_MAX_PER_SESSION: 3,
      ...config
    } as AppConfig,
    webhooks as unknown as WebhooksRepository,
    sessions as unknown as SessionsRepository
  )
  return { service, webhooks, sessions }
}

const PUBLIC_URL = 'https://8.8.8.8/hook'

// The gateway attaches no `raw` to a message when INCLUDE_RAW is off, so a webhook that asks for it
// would be created and then receive nothing, with no word about it
describe('includeRaw while INCLUDE_RAW is off', () => {
  const off = { INCLUDE_RAW: false }

  it('refuses to create a webhook that asks for the raw data', async () => {
    const { service, webhooks } = setup(off)

    await expect(service.create({ url: PUBLIC_URL, includeRaw: true })).rejects.toBeInstanceOf(
      ValidationError
    )
    expect(webhooks.create).not.toHaveBeenCalled()
  })

  it('refuses to change a webhook to ask for it', async () => {
    const { service, webhooks } = setup(off)

    await expect(service.update(ADMIN, ID, { includeRaw: true })).rejects.toBeInstanceOf(
      ValidationError
    )
    expect(webhooks.updateIfEvents).not.toHaveBeenCalled()
  })

  it('says why', async () => {
    const { service } = setup(off)

    await expect(service.update(ADMIN, ID, { includeRaw: true })).rejects.toThrow(/INCLUDE_RAW/)
  })

  it('still takes a webhook that follows INCLUDE_RAW or turns the raw data off', async () => {
    const { service } = setup(off)

    await expect(service.create({ url: PUBLIC_URL })).resolves.toBeDefined()
    await expect(service.create({ url: PUBLIC_URL, includeRaw: false })).resolves.toBeDefined()
    await expect(service.update(ADMIN, ID, { includeRaw: null })).resolves.toBeDefined()
  })

  it('takes a webhook that asks for the raw data while INCLUDE_RAW is on', async () => {
    const { service } = setup({ INCLUDE_RAW: true })

    await expect(service.create({ url: PUBLIC_URL, includeRaw: true })).resolves.toBeDefined()
  })
})

describe('toWebhookDto', () => {
  it('never carries the secret', () => {
    const dto = toWebhookDto(row())

    expect(dto).not.toHaveProperty('secret')
    expect(dto).toMatchObject({ id: ID, createdAt: '2026-01-01T00:00:00.000Z', includeRaw: null })
  })
})

describe('receivesEvent', () => {
  it.each([
    [['*'], 'message', true],
    [['message'], 'message', true],
    [['message'], 'ready', false],
    [['ready', 'message'], 'message', true],
    // The wildcard never carries a login credential: qr and code are asked for by name
    [['*'], 'qr', false],
    [['*'], 'code', false],
    [['qr'], 'qr', true],
    [['code', 'ready'], 'code', true],
    [['qr'], 'code', false]
  ])('%j and %s is %s', (events, event, expected) => {
    expect(receivesEvent({ events }, event)).toBe(expected)
  })
})

describe('WebhookService.create', () => {
  it('returns the generated secret once and stores the same one', async () => {
    const { service, webhooks } = setup()

    const created = await service.create({ url: PUBLIC_URL, sessionId: 'main' })

    expect(created.secret).toMatch(/^whsec_[\w-]{43}$/)
    expect(webhooks.create).toHaveBeenCalledWith(
      expect.objectContaining({ secret: created.secret })
    )
    expect((await service.get(ID)) as object).not.toHaveProperty('secret')
  })

  it('keeps qr and code named next to a wildcard, which never carries them', async () => {
    const { service, webhooks } = setup()

    await service.create({ url: PUBLIC_URL, events: ['*', 'qr', 'message', 'code', 'qr'] })

    expect(webhooks.create).toHaveBeenCalledWith(
      expect.objectContaining({ events: ['*', 'qr', 'code'] })
    )
  })

  it('collapses a wildcard to ["*"]', async () => {
    const { service, webhooks } = setup()

    await service.create({ url: PUBLIC_URL, events: ['message', '*'] })
    await service.update(ADMIN, ID, { events: ['ready', '*', 'ready'] })

    expect(webhooks.create).toHaveBeenCalledWith(expect.objectContaining({ events: ['*'] }))
    expect(webhooks.updateIfEvents).toHaveBeenCalledWith(
      ID,
      ['*'],
      expect.objectContaining({ events: ['*'] })
    )
  })

  it('stores a global webhook with a null session and de-duplicates the events', async () => {
    const { service, webhooks } = setup()

    await service.create({ url: PUBLIC_URL, events: ['message', 'ready', 'message'] })

    expect(webhooks.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: null, events: ['message', 'ready'] })
    )
  })

  it('refuses a session that does not exist', async () => {
    const { service, webhooks, sessions } = setup()
    sessions.findById.mockResolvedValueOnce(null as never)

    await expect(service.create({ url: PUBLIC_URL, sessionId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(webhooks.create).not.toHaveBeenCalled()
  })

  it('answers not found when the session is deleted before the insert', async () => {
    const { service, webhooks } = setup()
    webhooks.create.mockResolvedValueOnce(null)

    await expect(service.create({ url: PUBLIC_URL, sessionId: 'main' })).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it.each(['http://127.0.0.1/hook', 'http://169.254.169.254/latest', 'ftp://8.8.8.8/x'])(
    'refuses %s',
    async url => {
      const { service, webhooks } = setup()

      await expect(service.create({ url })).rejects.toBeInstanceOf(ValidationError)
      expect(webhooks.create).not.toHaveBeenCalled()
    }
  )

  it('accepts a private target that is on the allowlist, never the metadata address', async () => {
    const { service } = setup({ WEBHOOK_PRIVATE_HOST_ALLOWLIST: ['10.0.0.0/8', '169.254.0.0/16'] })

    await expect(service.create({ url: 'http://10.1.2.3:3000/hook' })).resolves.toBeDefined()
    await expect(service.create({ url: 'http://169.254.169.254/x' })).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it('accepts any target when private ones are allowed', async () => {
    const { service } = setup({ ALLOW_PRIVATE_WEBHOOK_TARGETS: true })

    await expect(service.create({ url: 'http://127.0.0.1:3000/hook' })).resolves.toBeDefined()
  })
})

describe('WebhookService.update', () => {
  it('checks a new url and leaves the rest alone', async () => {
    const { service, webhooks } = setup()

    await expect(service.update(ADMIN, ID, { url: 'http://127.0.0.1/x' })).rejects.toBeInstanceOf(
      ValidationError
    )
    await service.update(ADMIN, ID, { enabled: false })

    expect(webhooks.updateIfEvents).toHaveBeenCalledTimes(1)
    expect(webhooks.updateIfEvents).toHaveBeenCalledWith(ID, ['*'], {
      enabled: false,
      events: undefined
    })
  })

  it('answers not found before resolving a new url', async () => {
    const { service, webhooks } = setup({ WEBHOOK_PRIVATE_HOST_ALLOWLIST: ['bad_entry!'] })
    webhooks.findById.mockResolvedValueOnce(null)

    // Resolving the url would throw a ValidationError for the entry above
    await expect(service.update(ADMIN, ID, { url: PUBLIC_URL })).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(webhooks.updateIfEvents).not.toHaveBeenCalled()
  })

  it('answers not found for a missing webhook', async () => {
    const { service, webhooks } = setup()
    webhooks.findById.mockResolvedValueOnce(null)

    await expect(service.update(ADMIN, ID, { enabled: false })).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

// The `manage` check for qr and code reads the webhook; the write must only go through while the
// webhook still is what the check read, or a key without `manage` could change the URL of a webhook
// that another key has just made listen to the QR code
describe('WebhookService, a webhook that changes between the check and the write', () => {
  const WEBHOOKS_ONLY = keyPrincipal('k', 'main', ['webhooks'])
  const MANAGER = keyPrincipal('k2', 'main', ['webhooks', 'manage'])

  it.each([
    ['update', (s: WebhookService) => s.update(WEBHOOKS_ONLY, ID, { enabled: false })],
    ['rotateSecret', (s: WebhookService) => s.rotateSecret(WEBHOOKS_ONLY, ID)]
  ])(
    'refuses %s when the events that were read changed and now name the QR code',
    async (_name, act) => {
      const { service, webhooks } = setup()
      webhooks.findById
        .mockResolvedValueOnce(row({ events: ['message'] }))
        .mockResolvedValueOnce(row({ events: ['message', 'qr'] }))
      // The compare-and-set finds the events changed
      webhooks.updateIfEvents.mockResolvedValueOnce(null)

      await expect(act(service)).rejects.toBeInstanceOf(ForbiddenError)
      expect(webhooks.updateIfEvents).toHaveBeenCalledTimes(1)
      expect(webhooks.updateIfEvents.mock.calls[0]?.[1]).toEqual(['message'])
    }
  )

  it('refuses a key without manage that names qr or code, or changes a webhook that does', async () => {
    const { service, webhooks } = setup()

    await expect(service.update(WEBHOOKS_ONLY, ID, { events: ['code'] })).rejects.toMatchObject({
      code: 'INSUFFICIENT_SCOPE'
    })
    webhooks.findById.mockResolvedValue(row({ events: ['qr'] }))
    // The URL is where the QR code goes: moving it would hand the code to someone else
    await expect(service.update(WEBHOOKS_ONLY, ID, { enabled: false })).rejects.toMatchObject({
      code: 'INSUFFICIENT_SCOPE'
    })
    // The secret signs what the receiver of the QR code trusts: whoever holds it can forge it
    await expect(service.rotateSecret(WEBHOOKS_ONLY, ID)).rejects.toMatchObject({
      code: 'INSUFFICIENT_SCOPE'
    })
    expect(webhooks.updateIfEvents).not.toHaveBeenCalled()
  })

  it('writes against the events it read, so the database can refuse a change in between', async () => {
    const { service, webhooks } = setup()
    webhooks.findById.mockResolvedValue(row({ events: ['message', 'qr'] }))

    await service.update(MANAGER, ID, { enabled: false })
    await service.rotateSecret(MANAGER, ID)

    expect(webhooks.updateIfEvents).toHaveBeenNthCalledWith(1, ID, ['message', 'qr'], {
      enabled: false,
      events: undefined
    })
    expect(webhooks.updateIfEvents.mock.calls[1]?.[1]).toEqual(['message', 'qr'])
  })

  it('reads again and goes through when the change was harmless', async () => {
    const { service, webhooks } = setup()
    webhooks.findById
      .mockResolvedValueOnce(row({ events: ['message'] }))
      .mockResolvedValueOnce(row({ events: ['ready'] }))
    webhooks.updateIfEvents.mockResolvedValueOnce(null)

    await expect(service.update(WEBHOOKS_ONLY, ID, { enabled: false })).resolves.toBeDefined()
    expect(webhooks.updateIfEvents.mock.calls.map(call => call[1])).toEqual([
      ['message'],
      ['ready']
    ])
  })

  it('gives up with a conflict when the webhook keeps changing under the write', async () => {
    const { service, webhooks } = setup()
    webhooks.updateIfEvents.mockResolvedValue(null)

    await expect(service.update(WEBHOOKS_ONLY, ID, { enabled: false })).rejects.toBeInstanceOf(
      ConflictError
    )
    expect(webhooks.updateIfEvents).toHaveBeenCalledTimes(3)
  })

  it('answers not found when the webhook is deleted between the read and the write', async () => {
    const { service, webhooks } = setup()
    webhooks.updateIfEvents.mockResolvedValueOnce(null)
    webhooks.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(null)

    await expect(service.rotateSecret(ADMIN, ID)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('WebhookService.invalidate', () => {
  it('makes the next dispatch read the enabled webhooks again, as a webhook write does', async () => {
    const { service, webhooks } = setup()

    await service.forEvent('main', 'message')
    await service.forEvent('main', 'message')
    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(1)

    // The webhooks of a session go with it (cascade); the cache must not keep them
    webhooks.listEnabledFor.mockResolvedValueOnce([])
    service.invalidate()

    expect(await service.forEvent('main', 'message')).toEqual([])
    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(2)
  })

  it('does not let a read that began before it fill the cache with its stale answer', async () => {
    const { service, webhooks } = setup()
    let release: (rows: Webhook[]) => void = () => undefined
    webhooks.listEnabledFor.mockImplementationOnce(
      () => new Promise<Webhook[]>(resolve => (release = resolve))
    )

    const pending = service.forEvent('main', 'message')
    service.invalidate()
    release([row()])
    await pending
    await service.forEvent('main', 'message')

    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(2)
  })
})

describe('WebhookService.rotateSecret', () => {
  it('returns a new secret and stores it', async () => {
    const { service, webhooks } = setup()

    const rotated = await service.rotateSecret(ADMIN, ID)

    expect(rotated.secret).toMatch(/^whsec_/)
    expect(rotated.secret).not.toBe('whsec_stored')
    expect(webhooks.updateIfEvents).toHaveBeenCalledWith(ID, ['*'], { secret: rotated.secret })
  })

  it('answers not found for a missing webhook', async () => {
    const { service, webhooks } = setup()
    webhooks.findById.mockResolvedValueOnce(null)

    await expect(service.rotateSecret(ADMIN, ID)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('WebhookService.get and delete', () => {
  it('answers not found for a missing webhook', async () => {
    const { service, webhooks } = setup()
    webhooks.findById.mockResolvedValue(null)
    webhooks.delete.mockResolvedValue(false)

    await expect(service.get(ID)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.require(ID)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.delete(ID)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('lists without the secrets', async () => {
    const { service } = setup()

    const list = await service.list('main')

    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('secret')
  })
})

describe('WebhookService.forEvent', () => {
  it('filters by event and reads the database once per session', async () => {
    const { service, webhooks } = setup()
    webhooks.listEnabledFor.mockResolvedValue([
      row({ id: 'all', events: ['*'] }),
      row({ id: 'msg', events: ['message'] }),
      row({ id: 'ready', events: ['ready'] })
    ])

    const forMessage = await service.forEvent('main', 'message')
    const forReady = await service.forEvent('main', 'ready')

    expect(forMessage.map(w => w.id)).toEqual(['all', 'msg'])
    expect(forReady.map(w => w.id)).toEqual(['all', 'ready'])
    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(1)
  })

  it('gives qr and code only to the webhook that names them, not to a wildcard', async () => {
    const { service, webhooks } = setup()
    webhooks.listEnabledFor.mockResolvedValue([
      row({ id: 'all', events: ['*'] }),
      row({ id: 'named', events: ['*', 'qr'] }),
      row({ id: 'msg', events: ['message'] })
    ])

    expect((await service.forEvent('main', 'qr')).map(w => w.id)).toEqual(['named'])
    expect((await service.forEvent('main', 'code')).map(w => w.id)).toEqual([])
    expect((await service.forEvent('main', 'message')).map(w => w.id)).toEqual([
      'all',
      'named',
      'msg'
    ])
  })

  it.each([
    ['create', (s: WebhookService) => s.create({ url: PUBLIC_URL })],
    ['update', (s: WebhookService) => s.update(ADMIN, ID, { enabled: false })],
    ['rotateSecret', (s: WebhookService) => s.rotateSecret(ADMIN, ID)],
    ['delete', (s: WebhookService) => s.delete(ID)]
  ])('reads again after %s', async (_name, write) => {
    const { service, webhooks } = setup()
    await service.forEvent('main', 'message')

    await write(service)
    await service.forEvent('main', 'message')

    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(2)
  })

  it('drops the cache even when the write fails', async () => {
    const { service, webhooks } = setup()
    await service.forEvent('main', 'message')
    // The write finds nothing to change, and the webhook is gone when it is read again
    webhooks.updateIfEvents.mockResolvedValueOnce(null)
    webhooks.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(null)

    await expect(service.update(ADMIN, ID, { enabled: false })).rejects.toBeInstanceOf(
      NotFoundError
    )
    await service.forEvent('main', 'message')

    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(2)
  })

  it('drops the cache when the write throws after it may have committed', async () => {
    const { service, webhooks } = setup()
    await service.forEvent('main', 'message')
    webhooks.updateIfEvents.mockRejectedValueOnce(new Error('connection reset'))

    await expect(service.rotateSecret(ADMIN, ID)).rejects.toThrow('connection reset')
    await service.forEvent('main', 'message')

    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(2)
  })

  it('does not cache a read that raced with a write', async () => {
    const { service, webhooks } = setup()
    let release: (rows: Webhook[]) => void = () => undefined
    webhooks.listEnabledFor.mockImplementationOnce(
      () => new Promise<Webhook[]>(resolve => (release = resolve))
    )

    const stale = service.forEvent('main', 'message')
    await service.delete(ID)
    release([row({ id: 'stale' })])
    await stale
    webhooks.listEnabledFor.mockResolvedValueOnce([row({ id: 'fresh' })])

    expect((await service.forEvent('main', 'message')).map(w => w.id)).toEqual(['fresh'])
  })
})

describe('WebhookService access by key', () => {
  const sessionKey = keyPrincipal('k', 'main', ['webhooks'])

  it('lists every webhook for an admin and those of its session for a session key', async () => {
    const { service, webhooks } = setup()

    await service.listFor(adminPrincipal('k'))
    await service.listFor(sessionKey)

    expect(webhooks.list.mock.calls).toEqual([[undefined], ['main']])
  })

  it('gives a session key the webhook of its own session', async () => {
    const { service } = setup()

    expect(await service.requireFor(sessionKey, ID)).toMatchObject({ id: ID })
  })

  it('refuses a session key the webhook of another session and the ones of every session', async () => {
    const { service, webhooks } = setup()

    webhooks.findById.mockResolvedValueOnce(row({ sessionId: 'other' }))
    await expect(service.requireFor(sessionKey, ID)).rejects.toBeInstanceOf(ForbiddenError)
    webhooks.findById.mockResolvedValueOnce(row({ sessionId: null }))
    await expect(service.requireFor(sessionKey, ID)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('gives an admin any webhook, and answers 404 for one that does not exist', async () => {
    const { service, webhooks } = setup()

    webhooks.findById.mockResolvedValueOnce(row({ sessionId: null }))
    expect(await service.requireFor(adminPrincipal('k'), ID)).toMatchObject({ sessionId: null })
    webhooks.findById.mockResolvedValueOnce(null)
    await expect(service.requireFor(sessionKey, ID)).rejects.toBeInstanceOf(NotFoundError)
  })
})

// A webhook is a row and, for every event of its session, a job in Redis: the number of webhooks a
// session can hold is what bounds that
describe('the limit of webhooks per session', () => {
  it('creates a webhook while the session is under the limit', async () => {
    const { service, webhooks } = setup()
    webhooks.countFor.mockResolvedValue(2)

    await expect(service.create({ url: PUBLIC_URL, sessionId: 'main' })).resolves.toBeDefined()

    expect(webhooks.countFor).toHaveBeenCalledWith('main')
  })

  it('refuses the one past the limit with its own code, and stores nothing', async () => {
    const { service, webhooks } = setup()
    webhooks.countFor.mockResolvedValue(3)

    const error: unknown = await service
      .create({ url: PUBLIC_URL, sessionId: 'main' })
      .catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ code: 'MAX_WEBHOOKS_REACHED', status: 409 })
    expect(webhooks.create).not.toHaveBeenCalled()
  })

  it('counts the webhooks of every session as one more group, with the same limit', async () => {
    const { service, webhooks } = setup()
    webhooks.countFor.mockResolvedValue(3)

    await expect(service.create({ url: PUBLIC_URL })).rejects.toMatchObject({
      code: 'MAX_WEBHOOKS_REACHED'
    })
    expect(webhooks.countFor).toHaveBeenCalledWith(null)
  })

  // A session key can fire many creations at once: the count and the insert must not be apart
  it('holds the limit when many creations arrive at the same time', async () => {
    const { service, webhooks } = setup()
    let stored = 0
    webhooks.countFor.mockImplementation(async () => {
      await new Promise(resolve => setImmediate(resolve))
      return stored
    })
    webhooks.create.mockImplementation(async data => {
      await new Promise(resolve => setImmediate(resolve))
      stored += 1
      return row(data)
    })

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.create({ url: PUBLIC_URL, sessionId: 'main' }))
    )

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    expect(stored).toBe(3)
    const refused = results.filter(result => result.status === 'rejected')
    expect(refused).toHaveLength(7)
    for (const result of refused) {
      expect(result.reason).toMatchObject({ code: 'MAX_WEBHOOKS_REACHED' })
    }
  })

  it('does not make a session wait for the creations of another', async () => {
    const { service, webhooks } = setup()
    let release: () => void = () => undefined
    webhooks.create.mockImplementationOnce(
      async data =>
        new Promise<Webhook>(resolve => {
          release = () => resolve(row(data))
        })
    )

    const slow = service.create({ url: PUBLIC_URL, sessionId: 'main' })
    await new Promise(resolve => setImmediate(resolve))
    await expect(service.create({ url: PUBLIC_URL })).resolves.toBeDefined()
    release()
    await slow
  })

  it('answers 404 for a session that does not exist before it counts anything', async () => {
    const { service, webhooks, sessions } = setup()
    sessions.findById.mockResolvedValue(null as never)

    await expect(service.create({ url: PUBLIC_URL, sessionId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(webhooks.countFor).not.toHaveBeenCalled()
  })

  it('does not count a change to a webhook that already exists', async () => {
    const { service, webhooks } = setup()
    webhooks.countFor.mockResolvedValue(99)

    await expect(service.update(ADMIN, ID, { enabled: false })).resolves.toBeDefined()
  })
})

describe('assertCredentialEventsAllowed', () => {
  const webhooksKey = keyPrincipal('k', 'main', ['webhooks'])
  const manageKey = keyPrincipal('k', 'main', ['webhooks', 'manage'])

  it.each([['qr'], ['code']])('refuses a key without manage that asks for %s', event => {
    let thrown: unknown
    try {
      assertCredentialEventsAllowed(webhooksKey, [event, 'message'])
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ForbiddenError)
    expect(thrown).toMatchObject({ code: 'INSUFFICIENT_SCOPE', details: { scope: 'manage' } })
  })

  it('lets a key with manage, and an admin, ask for them', () => {
    expect(() => {
      assertCredentialEventsAllowed(manageKey, ['qr', 'code'])
    }).not.toThrow()
    expect(() => {
      assertCredentialEventsAllowed(adminPrincipal('k'), ['qr'])
    }).not.toThrow()
  })

  it('lets any key ask for the rest, the wildcard and nothing', () => {
    expect(() => {
      assertCredentialEventsAllowed(webhooksKey, ['*', 'message', 'ready'])
    }).not.toThrow()
    expect(() => {
      assertCredentialEventsAllowed(webhooksKey, undefined)
    }).not.toThrow()
  })
})
