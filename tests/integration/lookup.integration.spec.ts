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

// Step 5.9 over the whole application with real Postgres and Redis and the fake client in place of
// Chromium: the lookups go through the guards, the registry, the service and the shared number cache
describe('lookup API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const id = `look-${randomUUID().slice(0, 8)}`
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
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string> = ADMIN,
    session = id
  ) =>
    application().inject({
      method,
      url: `/v1/sessions/${session}${path}`,
      headers
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

  // Numbers are random so the shared cache of one run never answers for another
  const digits = (): string =>
    `52${Math.floor(Math.random() * 1e10)
      .toString()
      .padStart(10, '0')}`
  const used: string[] = []
  const fresh = (): string => {
    const number = digits()
    used.push(number)
    return number
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
      await redis?.client.del(...used.map(number => `numid:${number}`))
      const keys = [...((await redis?.client.keys(`*${id}*`)) ?? []), `seq:${id}`]
      await redis?.client.del(...keys)
    } finally {
      await app?.close()
    }
  })

  beforeEach(() => {
    client().calls.length = 0
  })

  describe('numbers.lookup', () => {
    it('answers a registered number and caches the look-up for the next request', async () => {
      const number = fresh()

      const first = await call('GET', `/numbers/%2B${number}`)
      const second = await call('GET', `/numbers/${number}`)

      expect(first.statusCode).toBe(200)
      expect(first.json()).toEqual({
        number,
        registered: true,
        id: `${number}@c.us`,
        countryCode: '52',
        formatted: number
      })
      expect(second.json()).toEqual(first.json())
      expect(argsOf('getNumberId')).toEqual([[number]])
    })

    it('answers 200 registered=false for a number without an account, and does not ask for more', async () => {
      const number = fresh()
      client().script('getNumberId', () => null)

      const response = await call('GET', `/numbers/${number}`)
      client().unscript('getNumberId')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        number,
        registered: false,
        id: null,
        countryCode: null,
        formatted: null
      })
      expect(argsOf('getCountryCode')).toEqual([])
      expect(argsOf('getFormattedNumber')).toEqual([])
    })

    it.each(['12345', 'abc', `${'9'.repeat(16)}`, '5215500000001@c.us'])(
      'refuses %j with 400 and does not call the client',
      async number => {
        const response = await call('GET', `/numbers/${encodeURIComponent(number)}`)

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
        expect(argsOf('getNumberId')).toEqual([])
      }
    )

    it('needs the read scope, and a session that is ready', async () => {
      const number = fresh()

      const denied = await call('GET', `/numbers/${number}`, await keyWith(['send']))
      const allowed = await call('GET', `/numbers/${number}`, await keyWith(['read']))
      const notReady = await call('GET', `/numbers/${fresh()}`, ADMIN, idleId)

      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
      expect(allowed.statusCode).toBe(200)
      expect(notReady.statusCode).toBe(409)
      expect(notReady.json()).toMatchObject({ error: { code: 'SESSION_NOT_READY' } })
    })

    it('answers a failure of WhatsApp as 502', async () => {
      client().failNext('getNumberId', new WaOperationError('getNumberId'))

      const response = await call('GET', `/numbers/${fresh()}`)

      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
    })
  })

  describe('contacts.lidPhone', () => {
    it('passes the ids, once each, and answers the pairs', async () => {
      const pair = { lid: '100000000000001@lid', pn: '5215500000001@c.us' }
      client().script('getContactLidAndPhone', () => [pair])

      const response = await call(
        'GET',
        '/contacts/lid-phone?ids=100000000000001@lid,5215500000001@c.us,100000000000001@lid'
      )
      client().unscript('getContactLidAndPhone')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [pair] })
      expect(argsOf('getContactLidAndPhone')).toEqual([
        [['100000000000001@lid', '5215500000001@c.us']]
      ])
    })

    it.each(['', '?ids=', '?ids=nonsense', '?ids=1@g.us', '?ids=1@lid&other=1'])(
      'refuses the query %j with 400 and does not call the client',
      async query => {
        const response = await call('GET', `/contacts/lid-phone${query}`)

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
        expect(argsOf('getContactLidAndPhone')).toEqual([])
      }
    )

    it('needs the read scope, and a session that is ready', async () => {
      const denied = await call('GET', '/contacts/lid-phone?ids=1@lid', await keyWith(['send']))
      const notReady = await call('GET', '/contacts/lid-phone?ids=1@lid', ADMIN, idleId)

      expect(denied.statusCode).toBe(403)
      expect(notReady.statusCode).toBe(409)
      expect(argsOf('getContactLidAndPhone')).toEqual([])
    })
  })
})
