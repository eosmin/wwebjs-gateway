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

// F30 (H-LIVE-11) over the whole application with real Postgres and Redis and the fake client in
// place of Chromium: what `calls.reject` answers for each thing the page can tell the adapter
describe('calls API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const id = `calls-${randomUUID().slice(0, 8)}`
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
  const post = (url: string, payload?: object) =>
    application().inject({
      method: 'POST',
      url,
      headers: ADMIN,
      ...(payload !== undefined && { payload })
    })
  const reject = (callId: string, session = id) =>
    post(`/v1/sessions/${session}/calls/${callId}/reject`)

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

    expect((await post('/v1/sessions', { id })).statusCode).toBe(201)
    expect((await post(`/v1/sessions/${id}/start`)).statusCode).toBe(200)
    client().emit({ event: 'ready', data: {} })
    await until(
      async () =>
        (
          await application().inject({
            method: 'GET',
            url: `/v1/sessions/${id}`,
            headers: ADMIN
          })
        ).json<{ status: string }>().status === 'ready'
    )
    // A session that never starts, to see what the route answers while the session is not ready
    expect((await post('/v1/sessions', { id: idleId })).statusCode).toBe(201)
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

  it('answers 200 { confirmed: true } when the call left the list of the page', async () => {
    client().script('rejectCall', () => 'confirmed')

    const response = await reject('c1')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ confirmed: true })
    expect(
      client()
        .callsOf('rejectCall')
        .map(recorded => recorded.args)
    ).toEqual([['c1']])
  })

  it('answers 202 with a note when the reject was handed over and nothing shows the call ended', async () => {
    client().script('rejectCall', () => 'unconfirmed')

    const response = await reject('c2')

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ confirmed: false })
    expect(response.json<{ note: string }>().note).toMatch(/do not assume/)
  })

  it('answers 404 NOT_FOUND for a call the gateway does not hold', async () => {
    client().script('rejectCall', () => 'not_held')

    const response = await reject('c3')

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('answers 502 WHATSAPP_ERROR with the cause when this WhatsApp Web has no way to reject', async () => {
    client().script('rejectCall', () => {
      throw new WaOperationError('rejectCall', '[call-reject] the VoIP stack is not available')
    })

    const response = await reject('c4')

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
  })

  it('answers 409 SESSION_NOT_READY for a session that is not ready, without reaching the client', async () => {
    const response = await reject('c5', idleId)

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_READY' } })
  })

  it('needs the manage scope', async () => {
    const created = await post('/v1/api-keys', {
      name: `send-only-${id}`,
      sessionId: id,
      scopes: ['send']
    })
    const key = created.json<{ key: string }>().key

    const response = await application().inject({
      method: 'POST',
      url: `/v1/sessions/${id}/calls/c6/reject`,
      headers: { 'x-api-key': key }
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
    expect(client().callsOf('rejectCall')).toHaveLength(0)
  })
})
