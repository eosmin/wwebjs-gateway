import { NotFoundError, ValidationError } from '../common/errors.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Webhook } from '../database/models.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { WebhooksRepository } from '../database/repositories/webhooks.repository.js'

import { WebhookService, receivesEvent, toWebhookDto } from './webhook.service.js'

const ID = '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10'

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
    update: jest.fn<Promise<Webhook | null>, [string, Record<string, unknown>]>((_id, patch) =>
      Promise.resolve(row(patch as Partial<Webhook>))
    ),
    delete: jest.fn<Promise<boolean>, [string]>(() => Promise.resolve(true)),
    listEnabledFor: jest.fn<Promise<Webhook[]>, [string]>(() => Promise.resolve([row()]))
  }
  const sessions = {
    findById: jest.fn(() => Promise.resolve({ id: 'main' }))
  }
  const service = new WebhookService(
    {
      // An address literal needs no DNS lookup
      WEBHOOK_PRIVATE_HOST_ALLOWLIST: [],
      ALLOW_PRIVATE_WEBHOOK_TARGETS: false,
      ...config
    } as AppConfig,
    webhooks as unknown as WebhooksRepository,
    sessions as unknown as SessionsRepository
  )
  return { service, webhooks, sessions }
}

const PUBLIC_URL = 'https://8.8.8.8/hook'

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
    [['ready', 'message'], 'message', true]
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

  it('collapses a wildcard to ["*"]', async () => {
    const { service, webhooks } = setup()

    await service.create({ url: PUBLIC_URL, events: ['message', '*'] })
    await service.update(ID, { events: ['ready', '*', 'ready'] })

    expect(webhooks.create).toHaveBeenCalledWith(expect.objectContaining({ events: ['*'] }))
    expect(webhooks.update).toHaveBeenCalledWith(ID, expect.objectContaining({ events: ['*'] }))
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

    await expect(service.update(ID, { url: 'http://127.0.0.1/x' })).rejects.toBeInstanceOf(
      ValidationError
    )
    await service.update(ID, { enabled: false })

    expect(webhooks.update).toHaveBeenCalledTimes(1)
    expect(webhooks.update).toHaveBeenCalledWith(ID, { enabled: false, events: undefined })
  })

  it('answers not found before resolving a new url', async () => {
    const { service, webhooks } = setup({ WEBHOOK_PRIVATE_HOST_ALLOWLIST: ['bad_entry!'] })
    webhooks.findById.mockResolvedValueOnce(null)

    // Resolving the url would throw a ValidationError for the entry above
    await expect(service.update(ID, { url: PUBLIC_URL })).rejects.toBeInstanceOf(NotFoundError)
    expect(webhooks.update).not.toHaveBeenCalled()
  })

  it('answers not found for a missing webhook', async () => {
    const { service, webhooks } = setup()
    webhooks.update.mockResolvedValueOnce(null)

    await expect(service.update(ID, { enabled: false })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('WebhookService.rotateSecret', () => {
  it('returns a new secret and stores it', async () => {
    const { service, webhooks } = setup()

    const rotated = await service.rotateSecret(ID)

    expect(rotated.secret).toMatch(/^whsec_/)
    expect(rotated.secret).not.toBe('whsec_stored')
    expect(webhooks.update).toHaveBeenCalledWith(ID, { secret: rotated.secret })
  })

  it('answers not found for a missing webhook', async () => {
    const { service, webhooks } = setup()
    webhooks.update.mockResolvedValueOnce(null)

    await expect(service.rotateSecret(ID)).rejects.toBeInstanceOf(NotFoundError)
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

  it.each([
    ['create', (s: WebhookService) => s.create({ url: PUBLIC_URL })],
    ['update', (s: WebhookService) => s.update(ID, { enabled: false })],
    ['rotateSecret', (s: WebhookService) => s.rotateSecret(ID)],
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
    webhooks.update.mockResolvedValueOnce(null)

    await expect(service.update(ID, { enabled: false })).rejects.toBeInstanceOf(NotFoundError)
    await service.forEvent('main', 'message')

    expect(webhooks.listEnabledFor).toHaveBeenCalledTimes(2)
  })

  it('drops the cache when the write throws after it may have committed', async () => {
    const { service, webhooks } = setup()
    await service.forEvent('main', 'message')
    webhooks.update.mockRejectedValueOnce(new Error('connection reset'))

    await expect(service.rotateSecret(ID)).rejects.toThrow('connection reset')
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
