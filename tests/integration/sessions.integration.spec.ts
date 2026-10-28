import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { ApiKeysRepository } from '../../src/database/repositories/api-keys.repository.js'
import type { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import type { EventBusService as EventBusServiceType } from '../../src/whatsapp/event-bus.service.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import { FakeWhatsAppClientFactory } from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const QR_TEXT = '2@integration-test-qr-text'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

// Everything a key holds, whatever its type: the QR code must not be in any of it
async function dump(client: RedisService['client'], key: string): Promise<unknown> {
  switch (await client.type(key)) {
    case 'string':
      return client.get(key)
    case 'hash':
      return client.hgetall(key)
    case 'list':
      return client.lrange(key, 0, -1)
    case 'set':
      return client.smembers(key)
    case 'zset':
      return client.zrange(key, '0', '-1')
    case 'stream':
      return client.xrange(key, '-', '+')
    default:
      return null
  }
}

interface Subscription {
  event: string
  unsubscribe: jest.Mock
}

interface Interval {
  timer: NodeJS.Timeout
  delayMs: number | undefined
}

// The whole application over real Postgres and Redis, with the fake client in place of Chromium:
// the "server boots, creates a session and serves a QR" check of step 4.6
// The tests share one application and one session and run in order, like the steps of a real
// session: an early failure (start, QR) makes the later ones fail too, so read the first red one
describe('sessions API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const runId = randomUUID().slice(0, 8)
  const id = `boot-${runId}`
  const second = `life-${runId}`
  let app: NestFastifyApplication | undefined
  let sessions: SessionsRepository | undefined
  let redis: RedisService | undefined
  let apiKeysRepository: ApiKeysRepository | undefined
  let watchdogIntervalMs = 0
  // The timers and subscriptions the application registered while it booted
  const intervals: Interval[] = []
  const subscriptions: Subscription[] = []
  const cleared: unknown[] = []
  let closed = false

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const apiKeys = (): ApiKeysRepository => {
    if (apiKeysRepository === undefined) throw new Error('the application did not boot')
    return apiKeysRepository
  }
  const repository = (): SessionsRepository => {
    if (sessions === undefined) throw new Error('the application did not boot')
    return sessions
  }

  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = ADMIN
  ) => application().inject({ method, url, headers, ...(payload && { payload }) })

  const statusOf = async (sessionId: string): Promise<string> =>
    (await send('GET', `/v1/sessions/${sessionId}`)).json<{ status: string }>().status

  const reach = (sessionId: string, status: string): Promise<void> =>
    until(async () => (await statusOf(sessionId)) === status)

  const newClient = (sessionId: string) => {
    const client = factory.clientFor(sessionId)
    if (client === undefined) throw new Error('the session did not build a client')
    return client
  }

  async function keyFor(
    sessionId: string,
    scopes: string[]
  ): Promise<{ id: string; headers: Record<string, string> }> {
    const created = await send('POST', '/v1/api-keys', { name: 'own', sessionId, scopes })
    expect(created.statusCode).toBe(201)
    const body = created.json<{ id: string; key: string }>()
    return { id: body.id, headers: { 'x-api-key': body.key } }
  }

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    // ConfigModule validates the environment the first time anything imports it, so the real URLs
    // go in first and nothing of src/ is imported before this point
    setEnv({ DATABASE_URL, REDIS_URL })
    const { AppModule } = await import('../../src/app.module.js')
    const { APP_CONFIG } = await import('../../src/config/config.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { SessionsRepository } =
      await import('../../src/database/repositories/sessions.repository.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { ApiKeysRepository } =
      await import('../../src/database/repositories/api-keys.repository.js')
    const { EventBusService } = await import('../../src/whatsapp/event-bus.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')

    const realSetInterval = global.setInterval
    jest
      .spyOn(global, 'setInterval')
      .mockImplementation((...args: Parameters<typeof setInterval>) => {
        const timer = realSetInterval(...args)
        intervals.push({ timer, delayMs: args[1] })
        return timer
      })
    const realClearInterval = global.clearInterval
    jest.spyOn(global, 'clearInterval').mockImplementation(timer => {
      cleared.push(timer)
      realClearInterval(timer)
    })
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reason: it is called with its own `this` below
    const realSubscribe = EventBusService.prototype.subscribe
    jest.spyOn(EventBusService.prototype, 'subscribe').mockImplementation(function (
      this: EventBusServiceType,
      ...args: Parameters<typeof realSubscribe>
    ) {
      const unsubscribe = jest.fn(realSubscribe.apply(this, args))
      subscriptions.push({ event: String(args[0]), unsubscribe })
      return unsubscribe
    })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    sessions = app.get(SessionsRepository)
    redis = app.get(RedisService)
    apiKeysRepository = app.get(ApiKeysRepository)
    watchdogIntervalMs = app.get<{ WATCHDOG_INTERVAL_MS: number }>(APP_CONFIG).WATCHDOG_INTERVAL_MS
  })

  afterAll(async () => {
    try {
      // The last test closes the application; a failure before it leaves the rows to remove here
      if (!closed && app !== undefined) {
        for (const sessionId of [id, second]) {
          await sessions?.delete(sessionId)
          const keys = [...((await redis?.client.keys(`*${sessionId}*`)) ?? []), `seq:${sessionId}`]
          await redis?.client.del(...keys)
        }
      }
    } finally {
      try {
        if (!closed) {
          closed = true
          await app?.close()
        }
      } finally {
        jest.restoreAllMocks()
      }
    }
  })

  it('creates a session as `created`, without the internal seq bound', async () => {
    const response = await send('POST', '/v1/sessions', { id, name: 'Integration' })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ id, name: 'Integration', status: 'created' })
    expect(response.body).not.toContain('seqHighWater')
  })

  it('answers 409 for a session that exists', async () => {
    const response = await send('POST', '/v1/sessions', { id })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_ALREADY_EXISTS' } })
  })

  it('has no QR code before the session starts', async () => {
    const response = await send('GET', `/v1/sessions/${id}/qr`)

    expect(response.statusCode).toBe(404)
  })

  it('starts the session and serves the QR code the client shows, as text and as a PNG', async () => {
    const started = await send('POST', `/v1/sessions/${id}/start`)
    expect(started.statusCode).toBe(200)

    newClient(id).emit({ event: 'qr', data: { qr: QR_TEXT } })
    await reach(id, 'qr')

    const text = await send('GET', `/v1/sessions/${id}/qr`)
    expect(text.statusCode).toBe(200)
    expect(text.headers['cache-control']).toBe('no-store')
    expect(text.json()).toEqual({ qr: QR_TEXT, status: 'qr' })

    const image = await send('GET', `/v1/sessions/${id}/qr.png`)
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.headers['cache-control']).toBe('no-store')
    expect(image.rawPayload.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true)
  })

  it('gives the QR code to a manage key and refuses it to a read key of the same session', async () => {
    const reader = await keyFor(id, ['read', 'send', 'events'])
    const manager = await keyFor(id, ['manage'])

    for (const route of ['qr', 'qr.png']) {
      const refused = await send('GET', `/v1/sessions/${id}/${route}`, undefined, reader.headers)
      expect(refused.statusCode).toBe(403)
      expect(refused.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
      expect(refused.body).not.toContain(QR_TEXT)

      const served = await send('GET', `/v1/sessions/${id}/${route}`, undefined, manager.headers)
      expect(served.statusCode).toBe(200)
    }
  })

  it('keeps the QR code out of the session row and out of every Redis key of the session', async () => {
    const row = await repository().findById(id)
    expect(
      JSON.stringify(row, (_key, value: unknown) => (typeof value === 'bigint' ? '0' : value))
    ).not.toContain(QR_TEXT)

    const client = redis?.client
    if (client === undefined) throw new Error('the application did not boot')
    for (const key of await client.keys(`*${id}*`)) {
      expect(key).not.toContain(QR_TEXT)
      expect(JSON.stringify(await dump(client, key))).not.toContain(QR_TEXT)
    }
  })

  it('lists the session, and a session key sees only its own', async () => {
    const listing = await send('GET', '/v1/sessions')
    expect(listing.json<{ sessions: { id: string }[] }>().sessions.map(s => s.id)).toContain(id)

    const { headers } = await keyFor(id, ['read'])

    expect((await send('GET', `/v1/sessions/${id}`, undefined, headers)).statusCode).toBe(200)
    expect((await send('GET', '/v1/sessions/other', undefined, headers)).statusCode).toBe(403)
    expect((await send('GET', '/v1/sessions', undefined, headers)).statusCode).toBe(403)
  })

  it('keeps a manage key out of the lifecycle of another session', async () => {
    const { headers } = await keyFor(id, ['read', 'manage'])

    for (const [method, url] of [
      ['POST', '/v1/sessions/other/start'],
      ['PATCH', '/v1/sessions/other'],
      ['DELETE', '/v1/sessions/other']
    ] as const) {
      const response = await send(
        method,
        url,
        method === 'PATCH' ? { name: 'x' } : undefined,
        headers
      )
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    }
  })

  it('reads the client once the session is ready, and refuses before', async () => {
    const before = await send('GET', `/v1/sessions/${id}/state`)
    expect(before.statusCode).toBe(409)
    expect(before.json()).toMatchObject({ error: { code: 'SESSION_NOT_READY' } })

    newClient(id).emit({ event: 'ready', data: {} })
    await reach(id, 'ready')

    expect((await send('GET', `/v1/sessions/${id}/state`)).json()).toEqual({ state: 'CONNECTED' })
    expect((await send('GET', `/v1/sessions/${id}/wweb-version`)).json()).toEqual({
      version: '2.3000.0'
    })
    expect((await send('GET', `/v1/sessions/${id}/info`)).json()).toMatchObject({
      pushname: 'Fake'
    })
    expect((await send('GET', `/v1/sessions/${id}/qr`)).statusCode).toBe(404)
  })

  it('reports the status and the WhatsApp Web version of the session in the system info', async () => {
    const info = (await send('GET', '/v1/system/info')).json<{
      sessions: { items: { id: string; status: string; wwebVersion: string | null }[] }
    }>()

    expect(info.sessions.items).toContainEqual({ id, status: 'ready', wwebVersion: '2.3000.0' })
  })

  describe('PATCH', () => {
    it('updates the settings without touching what other services keep in them', async () => {
      await repository().update(id, { settings: { sendPolicy: { dailyColdSends: 5 } } })

      const response = await send('PATCH', `/v1/sessions/${id}`, {
        name: 'Renamed',
        settings: { backgroundSync: true }
      })

      expect(response.json()).toMatchObject({
        name: 'Renamed',
        settings: { sendPolicy: { dailyColdSends: 5 }, backgroundSync: true }
      })
    })

    it('loses no key when several requests arrive together', async () => {
      const keys = [
        'autoDownloadAudio',
        'autoDownloadDocuments',
        'autoDownloadPhotos',
        'autoDownloadVideos',
        'backgroundSync'
      ]

      // Start from a row that holds none of the keys, so every one has to arrive through the race
      await repository().update(id, { settings: { sendPolicy: { dailyColdSends: 5 } } })

      const answers = await Promise.all(
        keys.map(key => send('PATCH', `/v1/sessions/${id}`, { settings: { [key]: true } }))
      )

      expect(answers.map(answer => answer.statusCode)).toEqual(keys.map(() => 200))

      const { settings } = (await send('GET', `/v1/sessions/${id}`)).json<{
        settings: Record<string, unknown>
      }>()
      expect(Object.keys(settings)).toEqual(expect.arrayContaining(keys))
      expect(settings).toHaveProperty('sendPolicy')
    })

    it('refuses a request that changes nothing', async () => {
      const response = await send('PATCH', `/v1/sessions/${id}`, {})

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    })
  })

  it('stops the session, which then does not start at the next boot', async () => {
    const response = await send('POST', `/v1/sessions/${id}/stop`)

    expect(response.json()).toMatchObject({ status: 'stopped', autoStart: false })
    expect((await repository().findById(id))?.autoStart).toBe(false)
    expect((await repository().listAutoStart()).map(row => row.id)).not.toContain(id)
  })

  it('deletes the session', async () => {
    const response = await send('DELETE', `/v1/sessions/${id}`)

    expect(response.statusCode).toBe(204)
    expect((await send('GET', `/v1/sessions/${id}`)).statusCode).toBe(404)
  })

  describe('the life of a running session', () => {
    let keyId: string

    beforeAll(async () => {
      expect((await send('POST', '/v1/sessions', { id: second })).statusCode).toBe(201)
      keyId = (await keyFor(second, ['read'])).id
      expect((await send('POST', `/v1/sessions/${second}/start`)).statusCode).toBe(200)
      newClient(second).emit({ event: 'ready', data: {} })
      await reach(second, 'ready')
    })

    it('resets the state of the client', async () => {
      const response = await send('POST', `/v1/sessions/${second}/reset-state`)

      expect(response.statusCode).toBe(204)
      expect(newClient(second).callsOf('resetState')).toHaveLength(1)
    })

    it('restarts with a new client and keeps the session starting at boot', async () => {
      const before = newClient(second)

      const response = await send('POST', `/v1/sessions/${second}/restart`)

      expect(response.statusCode).toBe(200)
      expect(newClient(second)).not.toBe(before)
      expect(before.callsOf('destroy')).toHaveLength(1)
      expect((await repository().findById(second))?.autoStart).toBe(true)
      newClient(second).emit({ event: 'ready', data: {} })
      await reach(second, 'ready')
    })

    it('logs out to `created` and stops starting at boot', async () => {
      const client = newClient(second)

      const response = await send('POST', `/v1/sessions/${second}/logout`)

      expect(response.json()).toMatchObject({ status: 'created', autoStart: false })
      expect(client.callsOf('logout')).toHaveLength(1)
      expect((await repository().findById(second))?.autoStart).toBe(false)
      expect((await repository().listAutoStart()).map(row => row.id)).not.toContain(second)
    })

    it('deletes a running session with its keys: the account is logged out and the browser closed', async () => {
      await send('POST', `/v1/sessions/${second}/start`)
      const client = newClient(second)
      client.emit({ event: 'ready', data: {} })
      await reach(second, 'ready')

      const response = await send('DELETE', `/v1/sessions/${second}`)

      expect(response.statusCode).toBe(204)
      expect(client.callsOf('logout')).toHaveLength(1)
      expect(client.callsOf('destroy')).toHaveLength(1)
      expect(await repository().findById(second)).toBeNull()
      expect(await apiKeys().findById(keyId)).toBeNull()
    })
  })

  it('runs the watchdog timer and the reconciler subscription, and ends them with the application', async () => {
    const watchdog = intervals.filter(({ delayMs }) => delayMs === watchdogIntervalMs)
    expect(watchdog.length).toBeGreaterThan(0)
    expect(subscriptions.map(({ event }) => event)).toContain('session_status')
    for (const { unsubscribe } of subscriptions) expect(unsubscribe).not.toHaveBeenCalled()
    cleared.length = 0

    closed = true
    await application().close()

    // Nothing the application subscribed to outlives it
    for (const { unsubscribe } of subscriptions) expect(unsubscribe).toHaveBeenCalledTimes(1)
    for (const { timer } of watchdog) expect(cleared).toContain(timer)
  })
})
