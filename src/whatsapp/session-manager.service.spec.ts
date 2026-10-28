import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import {
  FakeWhatsAppClient,
  FakeWhatsAppClientFactory
} from '../../tests/helpers/fake-whatsapp-client.js'
import { ConflictError, NotFoundError } from '../common/errors.js'
import { parseEnv } from '../config/env.schema.js'
import type { Session } from '../database/models.js'
import type {
  NewSession,
  SessionPatch,
  SessionsRepository
} from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { RedisService } from '../infra/redis/redis.service.js'
import type { SessionStatus } from '../types/dto.js'

import type { EventPipelineService } from './event-pipeline.service.js'
import { SessionManager } from './session-manager.service.js'
import { WaOperationError } from './wa-errors.js'

const NOW = new Date('2026-10-28T12:00:00.000Z')
const ID = 'support-line'
// What the fake client answers to getClientInfo
const PHONE = '5215500000001'

function buildRow(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: null,
    status: 'created',
    phoneNumber: null,
    pushName: null,
    autoStart: true,
    settings: {},
    createdAt: NOW,
    updatedAt: NOW,
    lastConnectedAt: null,
    lastEventAt: null,
    linkedAt: null,
    lastError: null,
    seqHighWater: 0n,
    ...overrides
  }
}

// The part of SessionsRepository the manager uses, kept in memory
class MemorySessions {
  readonly rows = new Map<string, Session>()

  readonly findById = jest.fn((id: string) => {
    const row = this.rows.get(id)
    return Promise.resolve(row ? { ...row } : null)
  })
  readonly create = jest.fn((data: NewSession) => {
    const row = buildRow({ id: data.id, autoStart: data.autoStart ?? true })
    this.rows.set(row.id, row)
    return Promise.resolve({ ...row })
  })
  readonly list = jest.fn(() => Promise.resolve([...this.rows.values()].map(row => ({ ...row }))))
  readonly update = jest.fn((id: string, patch: SessionPatch): Promise<Session | null> => {
    const row = this.rows.get(id)
    if (!row) return Promise.resolve(null)
    const entries = Object.entries(patch as Record<string, unknown>)
    Object.assign(row, Object.fromEntries(entries.filter(([, value]) => value !== undefined)))
    return Promise.resolve({ ...row })
  })
  readonly delete = jest.fn((id: string) => Promise.resolve(this.rows.delete(id)))

  seed(overrides: Partial<Session> & { id: string }): Session {
    const row = buildRow(overrides)
    this.rows.set(row.id, row)
    return row
  }
}

interface Published {
  sessionId: string
  event: string
  data: { status: SessionStatus; previous: SessionStatus; reason?: string }
}

interface Built {
  manager: SessionManager
  sessions: MemorySessions
  factory: FakeWhatsAppClientFactory
  // open/initialize/close/destroy in the order they happened
  trail: string[]
  published: Published[]
  pipeline: {
    open: jest.Mock
    close: jest.Mock
    closeAll: jest.Mock
    publish: jest.Mock
    forget: jest.Mock
  }
  redis: { scan: jest.Mock; del: jest.Mock }
  gauge(status: SessionStatus): Promise<number | undefined>
}

function build(
  env: Record<string, string> = {},
  behavior: {
    initializeFails?: boolean
    initialize?: () => Promise<void>
    factoryThrows?: boolean
  } = {}
): Built {
  const sessions = new MemorySessions()
  const factory = new FakeWhatsAppClientFactory()
  const trail: string[] = []
  const published: Published[] = []
  const pipeline = {
    open: jest.fn((sessionId: string) => {
      trail.push(`open:${sessionId}`)
      return Promise.resolve()
    }),
    close: jest.fn((sessionId: string) => {
      trail.push(`close:${sessionId}`)
      return Promise.resolve()
    }),
    closeAll: jest.fn(() => {
      trail.push('closeAll')
      return Promise.resolve()
    }),
    forget: jest.fn(),
    publish: jest.fn((sessionId: string, event: string, data: Published['data']) => {
      published.push({ sessionId, event, data })
      return Promise.resolve()
    })
  }
  const redis = {
    scan: jest.fn(() => Promise.resolve(['0', [`dedupe:${ID}:message:a`]])),
    del: jest.fn(() => Promise.resolve(2))
  }
  const metrics = new MetricsService()
  const manager = new SessionManager(
    parseEnv({ ...TEST_ENV, ...env }),
    sessions as unknown as SessionsRepository,
    pipeline as unknown as EventPipelineService,
    { client: redis } as unknown as RedisService,
    metrics,
    (sessionId, options) => {
      trail.push(`create:${sessionId}`)
      if (behavior.factoryThrows) throw new Error('no factory')
      const client = new FakeWhatsAppClient(sessionId, options)
      factory.clients.push(client)
      client.script('initialize', () => {
        trail.push(`initialize:${sessionId}`)
        if (behavior.initialize) return behavior.initialize()
        return behavior.initializeFails
          ? Promise.reject(new WaOperationError('no chromium'))
          : Promise.resolve()
      })
      return client
    }
  )
  return {
    manager,
    sessions,
    factory,
    trail,
    published,
    pipeline,
    redis,
    async gauge(status) {
      const metric = await metrics.metrics.sessions.get()
      return metric.values.find(value => value.labels['status'] === status)?.value
    }
  }
}

const flush = (): Promise<void> => jest.advanceTimersByTimeAsync(0)

// Holds the next write of a session row until `release` is called, so a test can queue commands and
// events behind a handler that is in flight
function holdNextUpdate(sessions: MemorySessions): () => void {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const real = sessions.update.getMockImplementation()
  if (!real) throw new Error('update has no implementation')
  sessions.update.mockImplementationOnce(async (id, patch) => {
    await gate
    return real(id, patch)
  })
  return release
}

// Moves fake time until the manager has made another client, failing instead of spinning for ever
async function untilNextClient(built: Built, before: number, maxMs = 400_000): Promise<number> {
  let waited = 0
  while (built.factory.clients.length === before) {
    if (waited >= maxMs) throw new Error('the manager did not reconnect')
    await jest.advanceTimersByTimeAsync(500)
    waited += 500
  }
  return waited
}

// Starts the session and returns the client the manager made for it
async function startSession(built: Built, id = ID): Promise<FakeWhatsAppClient> {
  await built.manager.start(id)
  const client = built.factory.clientFor(id)
  if (!client) throw new Error('no client')
  return client
}

async function makeReady(built: Built, client: FakeWhatsAppClient): Promise<void> {
  client.emit({ event: 'authenticated', data: {} })
  client.emit({ event: 'ready', data: {} })
  await flush()
  expect(built.manager.status(client.sessionId)).toBe('ready')
}

const statusesOf = (built: Built): SessionStatus[] => built.published.map(item => item.data.status)

let errorLog: jest.SpyInstance

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  jest.spyOn(Logger.prototype, 'warn').mockImplementation()
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation()
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('SessionManager create and start', () => {
  it('creates the row and answers 409 for an id that exists', async () => {
    const built = build()
    await expect(built.manager.create(ID, { autoStart: false })).resolves.toMatchObject({
      id: ID,
      autoStart: false
    })
    expect(built.manager.status(ID)).toBe('created')
    await expect(built.manager.create(ID)).rejects.toMatchObject({
      code: 'SESSION_ALREADY_EXISTS'
    })
  })

  it('opens the pipeline before the browser starts and announces the status', async () => {
    const built = build()
    await built.manager.create(ID)
    await startSession(built)
    await flush()

    expect(built.trail).toEqual([`create:${ID}`, `open:${ID}`, `initialize:${ID}`])
    expect(built.manager.status(ID)).toBe('starting')
    expect(built.published).toEqual([
      { sessionId: ID, event: 'session_status', data: { status: 'starting', previous: 'created' } }
    ])
    expect(built.pipeline.open).toHaveBeenCalledWith(ID, expect.anything(), {
      orderingEnabled: true
    })
  })

  it('hands the ordering switch of the session settings to the pipeline', async () => {
    const built = build()
    built.sessions.seed({ id: ID, settings: { ordering: { enabled: false } } })
    await built.manager.start(ID)
    expect(built.pipeline.open).toHaveBeenCalledWith(ID, expect.anything(), {
      orderingEnabled: false
    })
  })

  it('logs in with a phone number when asked to', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await built.manager.start(ID, { pairingPhoneNumber: '5215512345678' })
    expect(built.factory.clientFor(ID)?.options).toEqual({
      pairWithPhoneNumber: { phoneNumber: '5215512345678' }
    })
  })

  it('leaves a session that is already running alone', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await built.manager.start(ID)
    await built.manager.start(ID)
    expect(built.factory.clients).toHaveLength(1)
  })

  it('answers 404 for a session that does not exist', async () => {
    const built = build()
    await expect(built.manager.start('ghost')).rejects.toBeInstanceOf(NotFoundError)
    expect(() => built.manager.status('ghost')).toThrow(NotFoundError)
  })

  it('refuses a new session once MAX_SESSIONS are running', async () => {
    const built = build({ MAX_SESSIONS: '1' })
    built.sessions.seed({ id: 'a' })
    built.sessions.seed({ id: 'b' })
    await built.manager.start('a')

    await expect(built.manager.create('c')).rejects.toMatchObject({ code: 'MAX_SESSIONS_REACHED' })
    await expect(built.manager.start('b')).rejects.toMatchObject({ code: 'MAX_SESSIONS_REACHED' })
    // The one that runs is not counted against itself
    await expect(built.manager.start('a')).resolves.toMatchObject({ id: 'a' })

    await built.manager.stop('a')
    await expect(built.manager.start('b')).resolves.toMatchObject({ id: 'b' })
  })
})

describe('SessionManager status machine', () => {
  it('follows the events of the client and persists each status', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)

    client.emit({ event: 'qr', data: { qr: 'qr-text' } })
    await flush()
    expect(built.manager.status(ID)).toBe('qr')
    expect(built.manager.qr(ID)).toBe('qr-text')
    expect(built.sessions.rows.get(ID)?.status).toBe('qr')

    client.emit({ event: 'authenticated', data: {} })
    await flush()
    expect(built.manager.status(ID)).toBe('authenticating')
    expect(built.manager.qr(ID)).toBeUndefined()

    client.emit({ event: 'ready', data: {} })
    await flush()
    expect(built.manager.status(ID)).toBe('ready')
    expect(statusesOf(built)).toEqual(['starting', 'qr', 'authenticating', 'ready'])
    expect(built.published.map(item => item.data.previous)).toEqual([
      'created',
      'starting',
      'qr',
      'authenticating'
    ])
  })

  it('caches a new QR code without announcing a status that did not change', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    client.emit({ event: 'qr', data: { qr: 'first' } })
    client.emit({ event: 'qr', data: { qr: 'second' } })
    await flush()
    expect(built.manager.qr(ID)).toBe('second')
    expect(statusesOf(built)).toEqual(['starting', 'qr'])
  })

  it('moves to pairing_code when a pairing code is ready', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    client.emit({ event: 'code', data: { code: 'ABCD-1234' } })
    await flush()
    expect(built.manager.status(ID)).toBe('pairing_code')
  })

  it('stores the account on ready and clears the last error', async () => {
    const built = build()
    built.sessions.seed({ id: ID, lastError: 'old' })
    const client = await startSession(built)
    await makeReady(built, client)

    expect(built.sessions.rows.get(ID)).toMatchObject({
      status: 'ready',
      phoneNumber: PHONE,
      pushName: 'Fake',
      lastConnectedAt: NOW,
      linkedAt: NOW,
      lastError: null
    })
  })

  it('keeps the first linkedAt across later readies', async () => {
    const built = build()
    const linkedAt = new Date('2026-01-01T00:00:00.000Z')
    built.sessions.seed({ id: ID, linkedAt })
    const client = await startSession(built)
    await makeReady(built, client)
    expect(built.sessions.rows.get(ID)?.linkedAt).toEqual(linkedAt)
  })

  it('is ready even when the account cannot be read', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    client.failNext('getClientInfo', new WaOperationError('boom'))
    await makeReady(built, client)
    expect(built.sessions.rows.get(ID)).toMatchObject({ status: 'ready', phoneNumber: null })
  })

  it('applies the flags of the session settings on ready, skipping the ones not set', async () => {
    const built = build()
    built.sessions.seed({
      id: ID,
      settings: { autoDownloadAudio: true, autoDownloadPhotos: false, backgroundSync: true }
    })
    const client = await startSession(built)
    client.failNext('setAutoDownloadAudio', new WaOperationError('boom'))
    await makeReady(built, client)

    expect(client.callsOf('setAutoDownloadAudio')[0]?.args).toEqual([true])
    expect(client.callsOf('setAutoDownloadPhotos')[0]?.args).toEqual([false])
    expect(client.callsOf('setBackgroundSync')[0]?.args).toEqual([true])
    expect(client.callsOf('setAutoDownloadVideos')).toHaveLength(0)
    expect(client.callsOf('setAutoDownloadDocuments')).toHaveLength(0)
  })

  it('ignores settings that do not match the expected shape', async () => {
    const built = build()
    built.sessions.seed({ id: ID, settings: { ordering: 'yes', autoDownloadAudio: 'maybe' } })
    const client = await startSession(built)
    await makeReady(built, client)
    expect(client.callsOf('setAutoDownloadAudio')).toHaveLength(0)
    expect(built.pipeline.open).toHaveBeenCalledWith(ID, expect.anything(), {
      orderingEnabled: true
    })
  })

  it('fails without retrying when the saved session is refused', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    client.emit({ event: 'auth_failure', data: { message: 'bad session' } })
    await flush()

    expect(built.manager.status(ID)).toBe('failed')
    expect(built.sessions.rows.get(ID)?.lastError).toBe('auth failure')
    expect(client.callsOf('destroy')).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(600_000)
    expect(built.factory.clients).toHaveLength(1)
  })

  it('goes back to created on a LOGOUT, forgets the account and does not retry', async () => {
    const built = build()
    built.sessions.seed({ id: ID, linkedAt: NOW, phoneNumber: PHONE, pushName: 'Fake' })
    const client = await startSession(built)
    await makeReady(built, client)

    client.emit({ event: 'disconnected', data: { reason: 'LOGOUT' } })
    await flush()

    expect(built.manager.status(ID)).toBe('created')
    expect(built.sessions.rows.get(ID)).toMatchObject({
      status: 'created',
      autoStart: false,
      phoneNumber: null,
      pushName: null,
      linkedAt: null
    })
    await jest.advanceTimersByTimeAsync(600_000)
    expect(built.factory.clients).toHaveLength(1)
  })

  it('fails on a CONFLICT unless the takeover is on', async () => {
    const off = build()
    off.sessions.seed({ id: ID })
    const client = await startSession(off)
    client.emit({ event: 'change_state', data: { state: 'CONFLICT' } })
    await flush()
    expect(off.manager.status(ID)).toBe('failed')
    expect(off.sessions.rows.get(ID)?.lastError).toMatch(/CONFLICT/)

    const on = build({ TAKEOVER_ON_CONFLICT: 'true' })
    on.sessions.seed({ id: ID })
    const takeover = await startSession(on)
    takeover.emit({ event: 'change_state', data: { state: 'CONFLICT' } })
    await flush()
    expect(on.manager.status(ID)).toBe('starting')
  })

  it('ignores the events nobody reacts to', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    client.emit({ event: 'loading_screen', data: { percent: '50', message: 'x' } })
    client.emit({ event: 'change_state', data: { state: 'CONNECTED' } })
    await flush()
    expect(statusesOf(built)).toEqual(['starting'])
  })

  it('keeps going when the status cannot be saved or published', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    built.sessions.update.mockRejectedValueOnce(new Error('db down'))
    built.pipeline.publish.mockRejectedValueOnce(new Error('redis down'))
    client.emit({ event: 'qr', data: { qr: 'x' } })
    await flush()
    expect(built.manager.status(ID)).toBe('qr')
  })

  it('counts the sessions of each status in the gauge', async () => {
    const built = build()
    built.sessions.seed({ id: 'a' })
    built.sessions.seed({ id: 'b' })
    built.manager.onApplicationBootstrap()
    await flush()
    expect(await built.gauge('created')).toBe(2)

    const client = await startSession(built, 'a')
    await makeReady(built, client)
    expect(await built.gauge('created')).toBe(1)
    expect(await built.gauge('ready')).toBe(1)
  })
})

describe('SessionManager reconnect', () => {
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
  })

  async function ready(built: Built): Promise<FakeWhatsAppClient> {
    const client = await startSession(built)
    await makeReady(built, client)
    return client
  }

  it('destroys the client, waits and starts a new one', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await ready(built)
    built.trail.length = 0

    client.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
    await flush()

    expect(built.manager.status(ID)).toBe('disconnected')
    expect(built.sessions.rows.get(ID)?.lastError).toBe('disconnected (NAVIGATION)')
    expect(built.published.at(-1)?.data).toEqual({
      status: 'disconnected',
      previous: 'ready',
      reason: 'disconnected (NAVIGATION)'
    })
    // The pipeline is closed while the client is still there, then the client goes
    expect(built.trail).toEqual([`close:${ID}`])
    expect(client.callsOf('destroy')).toHaveLength(1)
    expect(client.listenerCount).toBe(0)
    expect(() => built.manager.requireReady(ID)).toThrow(ConflictError)

    await jest.advanceTimersByTimeAsync(2499)
    expect(built.factory.clients).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(built.factory.clients).toHaveLength(2)
    expect(built.trail).toEqual([`close:${ID}`, `create:${ID}`, `open:${ID}`, `initialize:${ID}`])
    expect(built.manager.status(ID)).toBe('starting')
  })

  it('doubles the wait of every attempt up to five minutes, with jitter', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await ready(built)
    const waits: number[] = []

    for (let attempt = 1; attempt <= 9; attempt++) {
      const before = built.factory.clients.length
      const client = built.factory.clientFor(ID)
      client?.emit({ event: 'session_error', data: { code: 'CRASH', message: 'x' } })
      await flush()
      const waited = await untilNextClient(built, before)
      waits.push(waited)
    }
    // random = 0: half of the ceiling 5 s, 10 s, 20 s ... capped at 300 s
    expect(waits).toEqual([2500, 5000, 10_000, 20_000, 40_000, 80_000, 150_000, 150_000, 150_000])

    jest.spyOn(Math, 'random').mockReturnValue(0.5)
    const before = built.factory.clients.length
    built.factory.clientFor(ID)?.emit({ event: 'session_error', data: { code: 'x', message: 'x' } })
    await flush()
    await jest.advanceTimersByTimeAsync(224_999)
    expect(built.factory.clients).toHaveLength(before)
    await jest.advanceTimersByTimeAsync(1)
    expect(built.factory.clients).toHaveLength(before + 1)
  })

  it('reconnects after a session_error', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await ready(built)
    client.emit({ event: 'session_error', data: { code: 'BROWSER_CLOSED', message: 'x' } })
    await flush()

    expect(built.manager.status(ID)).toBe('disconnected')
    expect(built.sessions.rows.get(ID)?.lastError).toBe('session error (BROWSER_CLOSED)')
    await jest.advanceTimersByTimeAsync(2500)
    expect(built.factory.clients).toHaveLength(2)
  })

  it('treats a browser that does not start as a drop', async () => {
    const built = build({}, { initializeFails: true })
    built.sessions.seed({ id: ID })
    await built.manager.start(ID)
    await flush()

    expect(built.manager.status(ID)).toBe('disconnected')
    expect(built.sessions.rows.get(ID)?.lastError).toBe('initialize failed (WaOperationError)')
    await jest.advanceTimersByTimeAsync(2500)
    expect(built.factory.clients).toHaveLength(2)
  })

  it('treats a pipeline that cannot open as a drop', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    built.pipeline.open.mockRejectedValueOnce(new Error('no pipeline'))
    await built.manager.start(ID)
    await flush()
    expect(built.manager.status(ID)).toBe('disconnected')
    expect(built.sessions.rows.get(ID)?.lastError).toBe('start failed (Error)')
  })

  it('gives up as failed once SESSION_RECONNECT_MAX_ATTEMPTS are spent', async () => {
    const built = build({ SESSION_RECONNECT_MAX_ATTEMPTS: '2' })
    built.sessions.seed({ id: ID })
    await startSession(built)

    for (let attempt = 1; attempt <= 2; attempt++) {
      built.factory
        .clientFor(ID)
        ?.emit({ event: 'session_error', data: { code: 'x', message: 'x' } })
      await flush()
      expect(built.manager.status(ID)).toBe('disconnected')
      await jest.advanceTimersByTimeAsync(300_000)
    }
    built.factory.clientFor(ID)?.emit({ event: 'session_error', data: { code: 'x', message: 'x' } })
    await flush()

    expect(built.manager.status(ID)).toBe('failed')
    expect(built.sessions.rows.get(ID)?.lastError).toBe('reconnect attempts exhausted')
    const clients = built.factory.clients.length
    await jest.advanceTimersByTimeAsync(600_000)
    expect(built.factory.clients).toHaveLength(clients)
    expect(clients).toBe(3)
  })

  it('starts counting again after a ready', async () => {
    const built = build({ SESSION_RECONNECT_MAX_ATTEMPTS: '1' })
    built.sessions.seed({ id: ID })
    await startSession(built)

    // With one attempt allowed, a counter that was not reset would fail the second drop
    for (let round = 1; round <= 3; round++) {
      const client = built.factory.clientFor(ID)
      client?.emit({ event: 'ready', data: {} })
      await flush()
      expect(built.manager.status(ID)).toBe('ready')
      client?.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
      await flush()
      expect(built.manager.status(ID)).toBe('disconnected')
      await jest.advanceTimersByTimeAsync(300_000)
    }
  })

  it('stops waiting when the session is stopped in between', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await ready(built)
    client.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
    await flush()

    await built.manager.stop(ID)
    await jest.advanceTimersByTimeAsync(600_000)
    expect(built.factory.clients).toHaveLength(1)
    expect(built.manager.status(ID)).toBe('stopped')
  })

  it('survives a client that will not be destroyed', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await ready(built)
    client.script('destroy', () => new Promise<void>(() => undefined))
    client.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
    await jest.advanceTimersByTimeAsync(15_000)
    expect(built.manager.status(ID)).toBe('disconnected')
  })
})

describe('SessionManager commands', () => {
  it('stops a session for good', async () => {
    const built = build()
    built.sessions.seed({ id: ID, autoStart: true })
    const client = await startSession(built)
    await makeReady(built, client)

    await expect(built.manager.stop(ID)).resolves.toMatchObject({
      status: 'stopped',
      autoStart: false
    })
    expect(client.callsOf('destroy')).toHaveLength(1)
    expect(client.callsOf('logout')).toHaveLength(0)
    expect(built.published.at(-1)?.data).toEqual({ status: 'stopped', previous: 'ready' })
    expect(() => built.manager.requireReady(ID)).toThrow(ConflictError)
  })

  it('restarts with a new client and keeps autoStart', async () => {
    const built = build()
    built.sessions.seed({ id: ID, autoStart: true })
    const client = await startSession(built)
    await makeReady(built, client)

    await expect(built.manager.restart(ID)).resolves.toMatchObject({
      status: 'starting',
      autoStart: true
    })
    expect(client.callsOf('destroy')).toHaveLength(1)
    expect(built.factory.clients).toHaveLength(2)
    expect(statusesOf(built).slice(-2)).toEqual(['stopped', 'starting'])
  })

  it('logs out, forgets the account and does not come back at boot', async () => {
    const built = build()
    built.sessions.seed({ id: ID, linkedAt: NOW, phoneNumber: PHONE })
    const client = await startSession(built)
    await makeReady(built, client)

    await expect(built.manager.logout(ID)).resolves.toMatchObject({
      status: 'created',
      autoStart: false,
      phoneNumber: null,
      linkedAt: null
    })
    expect(client.callsOf('logout')).toHaveLength(1)
    expect(client.callsOf('destroy')).toHaveLength(1)
  })

  it('cannot log out a session that has no client', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await expect(built.manager.logout(ID)).rejects.toMatchObject({ code: 'SESSION_NOT_READY' })
  })

  it('removes the session, its row and its Redis keys', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    await makeReady(built, client)

    await built.manager.remove(ID)

    expect(client.callsOf('logout')).toHaveLength(1)
    expect(client.callsOf('destroy')).toHaveLength(1)
    expect(built.sessions.rows.has(ID)).toBe(false)
    expect(() => built.manager.status(ID)).toThrow(NotFoundError)
    expect(built.redis.scan).toHaveBeenCalledWith('0', 'MATCH', `dedupe:${ID}:*`, 'COUNT', 200)
    expect(built.redis.del).toHaveBeenCalledWith(`seq:${ID}`, `dedupe:${ID}:message:a`)
  })

  it('removes a session whose logout fails', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    client.script('logout', () => Promise.reject(new WaOperationError('gone')))
    await built.manager.remove(ID)
    await jest.advanceTimersByTimeAsync(600_000)
    expect(built.sessions.rows.has(ID)).toBe(false)
    expect(built.factory.clients).toHaveLength(1)
  })

  it('removes a session that never ran, and survives a Redis that fails', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    built.redis.scan.mockRejectedValueOnce(new Error('redis down'))
    await expect(built.manager.remove(ID)).resolves.toBeUndefined()
    expect(built.sessions.rows.has(ID)).toBe(false)
    await expect(built.manager.remove(ID)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('scans every page of the dedupe keys', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    built.redis.scan
      .mockResolvedValueOnce(['7', ['dedupe:support-line:a']])
      .mockResolvedValueOnce(['0', ['dedupe:support-line:b']])
    await built.manager.remove(ID)
    expect(built.redis.scan).toHaveBeenCalledTimes(2)
    expect(built.redis.del).toHaveBeenCalledWith(
      `seq:${ID}`,
      'dedupe:support-line:a',
      'dedupe:support-line:b'
    )
  })

  it('hands out the client only while the session is ready', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    built.manager.onApplicationBootstrap()
    await flush()
    expect(() => built.manager.requireReady(ID)).toThrow(ConflictError)

    const client = await startSession(built)
    await makeReady(built, client)
    expect(built.manager.requireReady(ID)).toBe(client)

    await built.manager.resetState(ID)
    expect(client.callsOf('resetState')).toHaveLength(1)
    expect(() => built.manager.requireReady('ghost')).toThrow(NotFoundError)
  })

  it('runs the commands of one session one after the other', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await Promise.all([built.manager.start(ID), built.manager.stop(ID), built.manager.start(ID)])
    expect(built.manager.status(ID)).toBe('starting')
    expect(built.factory.clients).toHaveLength(2)
    expect(built.factory.clients[0]?.callsOf('destroy')).toHaveLength(1)
  })
})

describe('SessionManager boot and shutdown', () => {
  const linked = { linkedAt: NOW, autoStart: true }

  it('starts the linked sessions one after another, SESSION_START_STAGGER_MS apart', async () => {
    const built = build({ SESSION_START_STAGGER_MS: '5000' })
    built.sessions.seed({ id: 'a', ...linked })
    built.sessions.seed({ id: 'b', ...linked })
    built.sessions.seed({ id: 'c', ...linked })

    built.manager.onApplicationBootstrap()
    await flush()
    expect(built.factory.clients.map(client => client.sessionId)).toEqual(['a'])
    await jest.advanceTimersByTimeAsync(4999)
    expect(built.factory.clients).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(built.factory.clients.map(client => client.sessionId)).toEqual(['a', 'b'])
    await jest.advanceTimersByTimeAsync(5000)
    expect(built.factory.clients.map(client => client.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('does not block the application while it waits', () => {
    const built = build()
    built.sessions.seed({ id: 'a', ...linked })
    expect(built.manager.onApplicationBootstrap()).toBeUndefined()
  })

  it('skips the sessions that are not linked or not meant to run', async () => {
    const built = build({ SESSION_START_STAGGER_MS: '1' })
    built.sessions.seed({ id: 'never-linked', autoStart: true })
    built.sessions.seed({ id: 'stopped-by-hand', linkedAt: NOW, autoStart: false })
    built.sessions.seed({ id: 'ok', ...linked })

    built.manager.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(100)
    expect(built.factory.clients.map(client => client.sessionId)).toEqual(['ok'])
  })

  it('settles the status a crash left behind in rows that will not start', async () => {
    const built = build()
    built.sessions.seed({ id: 'stale', status: 'ready', autoStart: false })
    built.sessions.seed({ id: 'fresh', status: 'created' })
    built.sessions.seed({ id: 'broken', status: 'failed' })

    built.manager.onApplicationBootstrap()
    await flush()

    expect(built.sessions.rows.get('stale')?.status).toBe('stopped')
    expect(built.sessions.rows.get('fresh')?.status).toBe('created')
    expect(built.sessions.rows.get('broken')?.status).toBe('failed')
    expect(built.published).toEqual([
      {
        sessionId: 'stale',
        event: 'session_status',
        data: { status: 'stopped', previous: 'ready', reason: 'gateway restarted' }
      }
    ])
  })

  it('goes on with the next session when one cannot start, and respects MAX_SESSIONS', async () => {
    const built = build({ SESSION_START_STAGGER_MS: '1', MAX_SESSIONS: '1' })
    built.sessions.seed({ id: 'a', ...linked })
    built.sessions.seed({ id: 'b', ...linked })

    built.manager.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(100)
    expect(built.factory.clients.map(client => client.sessionId)).toEqual(['a'])
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('[b] Restoring'))
  })

  it('logs a boot that cannot read the database instead of crashing', async () => {
    const built = build()
    built.sessions.list.mockRejectedValueOnce(new Error('db down'))
    built.manager.onApplicationBootstrap()
    await flush()
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Restoring the sessions failed'))
  })

  it('destroys every client at shutdown without logging out and stops the restore', async () => {
    const built = build({ SESSION_START_STAGGER_MS: '5000' })
    built.sessions.seed({ id: 'a', ...linked })
    built.sessions.seed({ id: 'b', ...linked })
    built.manager.onApplicationBootstrap()
    await flush()
    const client = built.factory.clientFor('a')
    const published = built.published.length

    await built.manager.beforeApplicationShutdown()
    await jest.advanceTimersByTimeAsync(60_000)

    expect(client?.callsOf('destroy')).toHaveLength(1)
    expect(client?.callsOf('logout')).toHaveLength(0)
    expect(built.factory.clients).toHaveLength(1)
    expect(built.published).toHaveLength(published)
    expect(built.sessions.rows.get('a')?.status).toBe('starting')
  })

  it('does not reconnect after shutdown', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    await makeReady(built, client)
    client.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
    await flush()

    await built.manager.beforeApplicationShutdown()
    await jest.advanceTimersByTimeAsync(600_000)
    expect(built.factory.clients).toHaveLength(1)
  })
})

describe('SessionManager races and edge cases', () => {
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
  })

  async function ready(built: Built): Promise<FakeWhatsAppClient> {
    const client = await startSession(built)
    await makeReady(built, client)
    return client
  }

  it('drops an event that was queued behind the drop that replaced its client', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const old = await ready(built)

    // Both reach the queue while the client is still listening; the second one finds a newer world
    old.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
    old.emit({ event: 'auth_failure', data: { message: 'late' } })
    await flush()

    expect(built.manager.status(ID)).toBe('disconnected')
    await jest.advanceTimersByTimeAsync(2500)
    expect(built.factory.clients).toHaveLength(2)
    expect(built.manager.status(ID)).toBe('starting')
  })

  it('ignores a browser that failed to start after a newer client took its place', async () => {
    const rejects: ((error: Error) => void)[] = []
    const built = build(
      {},
      { initialize: () => new Promise<void>((_resolve, reject) => rejects.push(reject)) }
    )
    built.sessions.seed({ id: ID })
    const old = await startSession(built)
    old.emit({ event: 'session_error', data: { code: 'x', message: 'x' } })
    await flush()
    await jest.advanceTimersByTimeAsync(2500)
    expect(built.factory.clients).toHaveLength(2)

    rejects[0]?.(new WaOperationError('too late'))
    await flush()

    expect(built.manager.status(ID)).toBe('starting')
    expect(built.factory.clients).toHaveLength(2)
    expect(built.factory.clients[1]?.callsOf('destroy')).toHaveLength(0)
  })

  it('removes a session that is waiting to reconnect and never relaunches it', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await ready(built)
    client.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
    await flush()
    expect(built.manager.status(ID)).toBe('disconnected')

    await built.manager.remove(ID)
    await jest.advanceTimersByTimeAsync(600_000)

    expect(built.sessions.rows.has(ID)).toBe(false)
    expect(built.factory.clients).toHaveLength(1)
    expect(built.pipeline.forget).toHaveBeenCalledWith(ID)
  })

  it('keeps the queue of a session usable after a command fails', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    built.sessions.update.mockRejectedValueOnce(new Error('db'))
    const results = await Promise.allSettled([built.manager.stop('ghost'), built.manager.start(ID)])
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
    expect(built.manager.status(ID)).toBe('starting')
  })

  it('makes a command wait for the event handler that is in flight', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    const release = holdNextUpdate(built.sessions)

    client.emit({ event: 'qr', data: { qr: 'x' } })
    const stopping = built.manager.stop(ID)
    await flush()
    expect(client.callsOf('destroy')).toHaveLength(0)

    release()
    await stopping
    expect(client.callsOf('destroy')).toHaveLength(1)
    expect(statusesOf(built)).toEqual(['starting', 'qr', 'stopped'])
  })

  it('frees the slot of a session that failed', async () => {
    const built = build({ MAX_SESSIONS: '1' })
    built.sessions.seed({ id: 'a' })
    built.sessions.seed({ id: 'b' })
    const client = await startSession(built, 'a')
    await expect(built.manager.start('b')).rejects.toMatchObject({ code: 'MAX_SESSIONS_REACHED' })

    client.emit({ event: 'auth_failure', data: { message: 'x' } })
    await flush()
    await expect(built.manager.start('b')).resolves.toMatchObject({ id: 'b' })
  })

  it('refuses a restart that would pass MAX_SESSIONS', async () => {
    const built = build({ MAX_SESSIONS: '1' })
    built.sessions.seed({ id: 'a' })
    built.sessions.seed({ id: 'b', status: 'stopped' })
    await built.manager.start('a')
    await expect(built.manager.restart('b')).rejects.toMatchObject({ code: 'MAX_SESSIONS_REACHED' })
    expect(built.factory.clients).toHaveLength(1)
  })

  it('restarts a session that is not running without announcing a stop', async () => {
    const built = build()
    built.sessions.seed({ id: ID, status: 'failed' })
    await built.manager.restart(ID)
    expect(statusesOf(built)).toEqual(['starting'])
    expect(built.published[0]?.data.previous).toBe('failed')
  })

  it('restarts a session that waits to reconnect and drops the wait', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await ready(built)
    client.emit({ event: 'disconnected', data: { reason: 'NAVIGATION' } })
    await flush()

    await built.manager.restart(ID)
    expect(built.factory.clients).toHaveLength(2)
    await jest.advanceTimersByTimeAsync(600_000)
    expect(built.factory.clients).toHaveLength(2)
  })

  it('keeps the phone number of a pairing login across a reconnect', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await built.manager.start(ID, { pairingPhoneNumber: '5215512345678' })
    built.factory.clientFor(ID)?.emit({ event: 'session_error', data: { code: 'x', message: 'x' } })
    await flush()
    await jest.advanceTimersByTimeAsync(2500)
    expect(built.factory.clients[1]?.options).toEqual({
      pairWithPhoneNumber: { phoneNumber: '5215512345678' }
    })
  })

  it('treats a factory that throws as a drop', async () => {
    const built = build({}, { factoryThrows: true })
    built.sessions.seed({ id: ID })
    await built.manager.start(ID)
    expect(built.manager.status(ID)).toBe('disconnected')
    expect(built.sessions.rows.get(ID)?.lastError).toBe('start failed (Error)')
  })

  it('waits between half and all of the ceiling, never more', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999999)
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await startSession(built)
    client.emit({ event: 'session_error', data: { code: 'x', message: 'x' } })
    await flush()
    await jest.advanceTimersByTimeAsync(4998)
    expect(built.factory.clients).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(built.factory.clients).toHaveLength(2)
  })

  it('turns autoStart back on when a session is started on purpose', async () => {
    const built = build()
    built.sessions.seed({ id: ID, autoStart: false })
    await expect(built.manager.start(ID)).resolves.toMatchObject({ autoStart: true })
    expect(built.sessions.rows.get(ID)?.autoStart).toBe(true)
  })

  it('does not wait for a database that never answers the status write', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    built.sessions.update.mockImplementation(() => new Promise(() => undefined))
    const starting = built.manager.start(ID)
    await jest.advanceTimersByTimeAsync(5000)
    await starting
    expect(built.manager.status(ID)).toBe('starting')
  })

  it('leaves a session as it is when the delete fails, with a status that is true', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    const client = await ready(built)
    built.sessions.delete.mockRejectedValueOnce(new Error('db'))

    await expect(built.manager.remove(ID)).rejects.toThrow('db')

    expect(built.manager.status(ID)).toBe('stopped')
    expect(client.callsOf('destroy')).toHaveLength(1)
    expect(built.sessions.rows.has(ID)).toBe(true)
  })

  it('does not stop a session that was started while the boot was reading the database', async () => {
    const built = build()
    const row = built.sessions.seed({ id: ID, status: 'ready', autoStart: false })
    let answer: (rows: Session[]) => void = () => undefined
    built.sessions.list.mockImplementationOnce(
      () => new Promise<Session[]>(resolve => (answer = resolve))
    )
    built.manager.onApplicationBootstrap()
    await built.manager.start(ID)

    answer([{ ...row }])
    await flush()

    expect(built.manager.status(ID)).toBe('starting')
    expect(statusesOf(built)).toEqual(['starting'])
  })

  it('does not leave a browser behind when the shutdown comes while a start is in flight', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    let open: () => void = () => undefined
    built.pipeline.open.mockImplementationOnce(() => new Promise<void>(resolve => (open = resolve)))
    const starting = built.manager.start(ID)
    await flush()
    const shutdown = built.manager.beforeApplicationShutdown()

    open()
    await Promise.all([starting, shutdown])
    await jest.advanceTimersByTimeAsync(600_000)

    const client = built.factory.clientFor(ID)
    expect(client?.callsOf('destroy')).toHaveLength(1)
    expect(client?.callsOf('initialize')).toHaveLength(0)
    expect(built.factory.clients).toHaveLength(1)
  })

  it('closes the pipelines only after every client is down', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await startSession(built)
    built.trail.length = 0

    await built.manager.beforeApplicationShutdown()

    expect(built.trail).toEqual([`close:${ID}`, 'closeAll'])
    expect(built.factory.clientFor(ID)?.callsOf('destroy')).toHaveLength(1)
  })

  it('does not start or restart anything once it is shutting down', async () => {
    const built = build()
    built.sessions.seed({ id: ID })
    await built.manager.beforeApplicationShutdown()
    await built.manager.start(ID)
    await built.manager.restart(ID)
    expect(built.factory.clients).toHaveLength(0)
  })

  it('does not start a stagger once it is shutting down', async () => {
    const built = build({ SESSION_START_STAGGER_MS: '60000' })
    built.sessions.seed({ id: 'a', linkedAt: NOW })
    built.sessions.seed({ id: 'b', linkedAt: NOW })
    let open: () => void = () => undefined
    built.pipeline.open.mockImplementationOnce(() => new Promise<void>(resolve => (open = resolve)))
    const timers = jest.spyOn(global, 'setTimeout')
    built.manager.onApplicationBootstrap()
    await flush()

    // The restore is inside the start of the first session when the shutdown comes
    const shutdown = built.manager.beforeApplicationShutdown()
    open()
    await shutdown
    await flush()

    expect(timers).not.toHaveBeenCalledWith(expect.any(Function), 60_000)
    expect(built.factory.clients).toHaveLength(1)
  })
})
