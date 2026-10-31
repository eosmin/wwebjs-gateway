import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import { WaOperationError } from '../../src/whatsapp/wa-errors.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import {
  FakeWhatsAppClientFactory,
  type FakeWhatsAppClient
} from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

// Step 5.8 over the whole application with real Postgres and Redis and the fake client in place of
// Chromium: presence, profile and settings go through the guards, the registry and the service
describe('presence, profile and settings API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const id = `prof-${randomUUID().slice(0, 8)}`
  const idleId = `${id}-idle`
  let app: NestFastifyApplication | undefined
  let sessions: SessionsRepository | undefined
  let redis: RedisService | undefined

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const client = (): FakeWhatsAppClient => {
    const found = factory.clientFor(id)
    if (found === undefined) throw new Error('the session did not build a client')
    return found
  }
  const call = (
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    payload?: object,
    headers: Record<string, string> = ADMIN,
    session = id
  ) =>
    application().inject({
      method,
      url: `/v1/sessions/${session}${path}`,
      headers,
      ...(payload !== undefined && { payload })
    })
  const argsOf = (method: Parameters<FakeWhatsAppClient['callsOf']>[0]) =>
    client()
      .callsOf(method)
      .map(recorded => recorded.args)
  const keyWith = async (scopes: string[]): Promise<Record<string, string>> => {
    const created = await application().inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: ADMIN,
      payload: { name: scopes.join('-'), sessionId: id, scopes }
    })
    return { 'x-api-key': created.json<{ key: string }>().key }
  }

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    setEnv({ DATABASE_URL, REDIS_URL, RATE_LIMIT_MAX: '100000' })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { SessionsRepository } =
      await import('../../src/database/repositories/sessions.repository.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    sessions = app.get(SessionsRepository)
    redis = app.get(RedisService)

    expect(
      (
        await application().inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: ADMIN,
          payload: { id }
        })
      ).statusCode
    ).toBe(201)
    expect((await call('POST', '/start')).statusCode).toBe(200)
    client().emit({ event: 'ready', data: {} })
    await until(async () => {
      const state = await application().inject({
        method: 'GET',
        url: `/v1/sessions/${id}`,
        headers: ADMIN
      })
      return state.json<{ status: string }>().status === 'ready'
    })
    // A session that never starts, to see what a route answers while the session is not ready
    await application().inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: ADMIN,
      payload: { id: idleId }
    })
  })

  afterAll(async () => {
    try {
      await sessions?.delete(id)
      await sessions?.delete(idleId)
      const keys = [...((await redis?.client.keys(`*${id}*`)) ?? []), `seq:${id}`]
      await redis?.client.del(...keys)
    } finally {
      await app?.close()
    }
  })

  beforeEach(() => {
    client().calls.length = 0
  })

  describe('presence', () => {
    it.each([
      ['available', 'sendPresenceAvailable', 'sendPresenceUnavailable'],
      ['unavailable', 'sendPresenceUnavailable', 'sendPresenceAvailable']
    ] as const)('%s calls only its own presence', async (state, called, other) => {
      const response = await call('POST', '/presence', { state })

      expect(response.statusCode).toBe(204)
      expect(argsOf(called)).toEqual([[]])
      expect(argsOf(other)).toEqual([])
    })

    it.each([{ state: 'online' }, {}, { state: 'available', extra: 1 }])(
      'refuses %j with 400 and does not call the client',
      async body => {
        const response = await call('POST', '/presence', body)

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
        expect(argsOf('sendPresenceAvailable')).toEqual([])
      }
    )

    it('needs the manage scope, and a session that is ready', async () => {
      const denied = await call(
        'POST',
        '/presence',
        { state: 'available' },
        await keyWith(['send'])
      )
      const notReady = await call('POST', '/presence', { state: 'available' }, ADMIN, idleId)

      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
      expect(notReady.statusCode).toBe(409)
      expect(notReady.json()).toMatchObject({ error: { code: 'SESSION_NOT_READY' } })
      expect(argsOf('sendPresenceAvailable')).toEqual([])
    })

    it('answers a failure of WhatsApp as 502', async () => {
      client().failNext('sendPresenceAvailable', new WaOperationError('sendPresenceAvailable'))

      const response = await call('POST', '/presence', { state: 'available' })

      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
    })
  })

  describe('profile', () => {
    it('sets the about text and the name', async () => {
      const status = await call('PUT', '/profile/status', { status: 'Atendemos de 9 a 18 h' })
      const name = await call('PUT', '/profile/display-name', { displayName: 'Soporte' })

      expect(status.statusCode).toBe(204)
      expect(name.statusCode).toBe(204)
      expect(argsOf('setStatus')).toEqual([['Atendemos de 9 a 18 h']])
      expect(argsOf('setDisplayName')).toEqual([['Soporte']])
    })

    it.each([
      ['/profile/status', { status: 'a'.repeat(140) }],
      ['/profile/status', { status: '' }],
      ['/profile/display-name', { displayName: 'a'.repeat(26) }],
      ['/profile/display-name', { displayName: 'x', extra: true }],
      ['/profile/picture', {}],
      ['/profile/picture', { source: { base64: 'AAAA' } }]
    ])('refuses %s with %j with 400', async (path, body) => {
      const response = await call('PUT', path, body)

      expect(response.statusCode).toBe(400)
      expect(argsOf('setStatus')).toEqual([])
      expect(argsOf('setDisplayName')).toEqual([])
      expect(argsOf('setProfilePicture')).toEqual([])
    })

    it('answers 502 when WhatsApp says it did not change the name', async () => {
      client().script('setDisplayName', () => false)

      const response = await call('PUT', '/profile/display-name', { displayName: 'Soporte' })
      client().unscript('setDisplayName')

      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
    })

    it('sets the picture from inline base64 and deletes it', async () => {
      const set = await call('PUT', '/profile/picture', {
        source: { base64: 'AAAA', mimetype: 'image/png' }
      })
      const removed = await call('DELETE', '/profile/picture')

      expect(set.statusCode).toBe(204)
      expect(removed.statusCode).toBe(204)
      expect(argsOf('setProfilePicture')).toEqual([[{ mimetype: 'image/png', data: 'AAAA' }]])
      expect(argsOf('deleteProfilePicture')).toEqual([[]])
    })

    it('refuses a picture that is not an image or not base64, and one with no media to reuse', async () => {
      const pdf = await call('PUT', '/profile/picture', {
        source: { base64: 'AAAA', mimetype: 'application/pdf' }
      })
      const broken = await call('PUT', '/profile/picture', {
        source: { base64: 'not base64!', mimetype: 'image/png' }
      })
      const absent = await call('PUT', '/profile/picture', {
        source: { messageId: 'true_5215500000001@c.us_ABC' }
      })

      expect(pdf.statusCode).toBe(400)
      expect(broken.statusCode).toBe(400)
      expect(absent.statusCode).toBe(404)
      expect(argsOf('setProfilePicture')).toEqual([])
    })

    it('answers 502 when WhatsApp refuses to delete the picture', async () => {
      client().script('deleteProfilePicture', () => false)

      const response = await call('DELETE', '/profile/picture')
      client().unscript('deleteProfilePicture')

      expect(response.statusCode).toBe(502)
    })

    it('needs the manage scope', async () => {
      const response = await call(
        'PUT',
        '/profile/status',
        { status: 'x' },
        await keyWith(['send'])
      )

      expect(response.statusCode).toBe(403)
      expect(argsOf('setStatus')).toEqual([])
    })
  })

  describe('settings', () => {
    beforeEach(async () => {
      await sessions?.update(id, { settings: {} })
    })

    it('applies only the settings sent', async () => {
      const response = await call('PUT', '/settings', {
        autoDownloadVideos: false,
        backgroundSync: true
      })

      expect(response.statusCode).toBe(204)
      expect(argsOf('setAutoDownloadVideos')).toEqual([[false]])
      expect(argsOf('setBackgroundSync')).toEqual([[true]])
      expect(argsOf('setAutoDownloadAudio')).toEqual([])
      expect(argsOf('setAutoDownloadDocuments')).toEqual([])
      expect(argsOf('setAutoDownloadPhotos')).toEqual([])
    })

    it('stores what it applied, next to the settings the session already has', async () => {
      await call('PATCH', '', { settings: { ordering: { enabled: false } } })
      await call('PUT', '/settings', { autoDownloadAudio: true })
      await call('PUT', '/settings', { autoDownloadVideos: false })

      const stored = await sessions?.findById(id)

      expect(stored?.settings).toEqual({
        ordering: { enabled: false },
        autoDownloadAudio: true,
        autoDownloadVideos: false
      })
    })

    it('stores the settings applied before a failure and no more', async () => {
      client().script('setAutoDownloadPhotos', () => {
        throw new WaOperationError('setAutoDownloadPhotos')
      })

      const response = await call('PUT', '/settings', {
        autoDownloadDocuments: true,
        autoDownloadPhotos: true,
        backgroundSync: true
      })
      client().unscript('setAutoDownloadPhotos')
      const stored = (await sessions?.findById(id))?.settings as Record<string, unknown>

      expect(response.statusCode).toBe(502)
      expect(stored.autoDownloadDocuments).toBe(true)
      expect(stored).not.toHaveProperty('autoDownloadPhotos')
      expect(stored).not.toHaveProperty('backgroundSync')
    })

    it.each([{}, { backgroundSync: 'yes' }, { other: true }])(
      'refuses %j with 400 and does not call the client',
      async body => {
        const response = await call('PUT', '/settings', body)

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
        expect(argsOf('setBackgroundSync')).toEqual([])
      }
    )

    it('needs the manage scope, and a session that is ready', async () => {
      const denied = await call(
        'PUT',
        '/settings',
        { backgroundSync: true },
        await keyWith(['read'])
      )
      const notReady = await call('PUT', '/settings', { backgroundSync: true }, ADMIN, idleId)

      expect(denied.statusCode).toBe(403)
      expect(notReady.statusCode).toBe(409)
      expect(argsOf('setBackgroundSync')).toEqual([])
    })
  })
})
