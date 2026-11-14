import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import {
  FakeWhatsAppClientFactory,
  type FakeWhatsAppClient
} from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const MAX_HOOKS = 3
const MAX_PER_MINUTE = 6

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

interface HookBody {
  id: string
  sessionId: string
  name: string
  revokedAt: string | null
  url?: string
}

// Step 8.2 over the whole application with real Postgres and Redis and the fake client: the routes that
// manage the hooks go through the key guard and the scopes; the token route needs no key and sends
// through the session of its hook, with the allowance of the hook and the limit of hooks per session.
describe('inbound hooks API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const suffix = randomUUID().slice(0, 8)
  const mine = `inb-${suffix}`
  const other = `inb-oth-${suffix}`
  let app: NestFastifyApplication | undefined
  let sessions: SessionsRepository | undefined
  let redis: RedisService | undefined
  const keys: Record<string, Record<string, string>> = {}

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const client = (id: string): FakeWhatsAppClient => {
    const found = factory.clientFor(id)
    if (found === undefined) throw new Error('the session did not build a client')
    return found
  }
  const manage = (
    method: 'GET' | 'POST' | 'DELETE',
    sessionId: string,
    path = '',
    payload?: object,
    headers: Record<string, string> = ADMIN
  ) =>
    application().inject({
      method,
      url: `/v1/sessions/${sessionId}/inbound-hooks${path}`,
      headers,
      ...(payload !== undefined && { payload })
    })
  const createHook = async (sessionId: string, name = 'crisp'): Promise<HookBody> => {
    const response = await manage('POST', sessionId, '', { name })
    expect(response.statusCode).toBe(201)
    return response.json<HookBody>()
  }
  // The path of the URL: what a system calls (the base is the public one of the gateway)
  const pathOf = (hook: HookBody): string => new URL(hook.url ?? '').pathname
  const inbound = (path: string, payload?: object | string, headers: Record<string, string> = {}) =>
    application().inject({
      method: 'POST',
      url: path,
      headers: {
        ...headers,
        ...(typeof payload === 'string' && { 'content-type': 'application/json' })
      },
      ...(payload !== undefined && { payload })
    })
  const revokeAll = async (sessionId: string): Promise<void> => {
    const list = await manage('GET', sessionId)
    for (const hook of list.json<{ hooks: HookBody[] }>().hooks) {
      await manage('DELETE', sessionId, `/${hook.id}`)
    }
  }
  const apiKey = async (sessionId: string, scopes: string[]): Promise<Record<string, string>> => {
    const response = await application().inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: ADMIN,
      payload: { name: `inb-${sessionId}-${scopes.join('-')}`, sessionId, scopes }
    })
    return { 'x-api-key': response.json<{ key: string }>().key }
  }

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    // A fresh account would be paced like a newborn number, and these tests send to strangers
    setEnv({
      DATABASE_URL,
      REDIS_URL,
      RATE_LIMIT_MAX: '100000',
      WEBHOOKS_MAX_PER_SESSION: String(MAX_HOOKS),
      INBOUND_HOOK_MAX_PER_MINUTE: String(MAX_PER_MINUTE),
      ALLOW_COLD_SENDS: 'true',
      WARMUP_DAYS: '0',
      SEND_MIN_INTERVAL_MS: '0',
      SEND_JITTER_MS: '0',
      PER_CHAT_MIN_INTERVAL_MS: '0',
      COLD_SEND_MIN_GAP_MS: '0',
      COLD_SENDS_PER_DAY: '200',
      PER_CHAT_MAX_PER_MINUTE: '60',
      SESSION_MAX_PER_MINUTE: '600',
      SESSION_MAX_PER_HOUR: '10000'
    })
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

    for (const id of [mine, other]) {
      const headers = ADMIN
      expect(
        (
          await application().inject({
            method: 'POST',
            url: '/v1/sessions',
            headers,
            payload: { id }
          })
        ).statusCode
      ).toBe(201)
      await application().inject({ method: 'POST', url: `/v1/sessions/${id}/start`, headers })
      client(id).emit({ event: 'ready', data: {} })
      // Typing before every text would only slow the tests
      await application().inject({
        method: 'PATCH',
        url: `/v1/sessions/${id}`,
        headers,
        payload: { settings: { humanize: { enabled: false } } }
      })
      await until(
        async () =>
          (await application().inject({ method: 'GET', url: `/v1/sessions/${id}`, headers })).json<{
            status: string
          }>().status === 'ready'
      )
    }
    keys['manage'] = await apiKey(mine, ['webhooks'])
    keys['sendOnly'] = await apiKey(mine, ['send'])
    keys['otherSession'] = await apiKey(other, ['webhooks'])
  })

  afterAll(async () => {
    try {
      // The hooks go with the sessions (cascade)
      await sessions?.delete(mine)
      await sessions?.delete(other)
      const stale = [
        ...((await redis?.client.keys(`*${mine}*`)) ?? []),
        ...((await redis?.client.keys(`*${other}*`)) ?? [])
      ]
      if (stale.length > 0) await redis?.client.del(...stale)
    } finally {
      await app?.close()
    }
  })

  describe('managing the hooks', () => {
    afterEach(() => revokeAll(mine))

    it('creates a hook and shows its URL once: the list never carries it', async () => {
      const hook = await createHook(mine)

      expect(hook).toMatchObject({ sessionId: mine, name: 'crisp', revokedAt: null })
      expect(hook.url).toMatch(/\/v1\/hooks\/inbound\/[A-Za-z0-9_-]{43}$/)

      const list = await manage('GET', mine)
      expect(list.statusCode).toBe(200)
      const body = list.json<{ hooks: HookBody[] }>()
      expect(body.hooks).toHaveLength(1)
      expect(body.hooks[0]).toMatchObject({ id: hook.id })
      expect(list.body).not.toContain(pathOf(hook).split('/').pop())
      expect(body.hooks[0]).not.toHaveProperty('url')
    })

    it('needs the webhooks scope and the session of the path', async () => {
      const noScope = await manage('POST', mine, '', { name: 'x' }, keys['sendOnly'])
      expect(noScope.statusCode).toBe(403)
      expect(noScope.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_SCOPE')

      const foreign = await manage('POST', mine, '', { name: 'x' }, keys['otherSession'])
      expect(foreign.statusCode).toBe(403)
      expect((await manage('GET', mine, '', undefined, keys['otherSession'])).statusCode).toBe(403)
      expect((await manage('POST', mine, '', { name: 'x' }, {})).statusCode).toBe(401)

      expect((await manage('POST', mine, '', { name: 'mine' }, keys['manage'])).statusCode).toBe(
        201
      )
    })

    it('answers 404 for an unknown session and validates the name', async () => {
      expect((await manage('POST', `nope-${suffix}`, '', { name: 'x' })).statusCode).toBe(404)
      expect((await manage('POST', mine, '', { name: '' })).statusCode).toBe(400)
      expect((await manage('POST', mine, '', { name: 'x', extra: 1 })).statusCode).toBe(400)
    })

    it('refuses the hook past WEBHOOKS_MAX_PER_SESSION, and a revoked one frees its place', async () => {
      const hooks: HookBody[] = []
      for (let i = 0; i < MAX_HOOKS; i += 1) hooks.push(await createHook(mine, `hook ${i}`))

      const refused = await manage('POST', mine, '', { name: 'one more' })
      expect(refused.statusCode).toBe(409)
      expect(refused.json<{ error: { code: string } }>().error.code).toBe(
        'MAX_INBOUND_HOOKS_REACHED'
      )
      // Another session has its own places
      expect((await manage('POST', other, '', { name: 'x' })).statusCode).toBe(201)

      const first = hooks[0]
      if (first === undefined) throw new Error('no hook')
      expect((await manage('DELETE', mine, `/${first.id}`)).statusCode).toBe(200)
      expect((await manage('POST', mine, '', { name: 'now it fits' })).statusCode).toBe(201)
      await revokeAll(other)
    })

    it('counts a burst of creations as one step: it cannot pass the limit', async () => {
      const results = await Promise.all(
        Array.from({ length: MAX_HOOKS + 4 }, (_, i) => manage('POST', mine, '', { name: `b${i}` }))
      )

      expect(results.filter(r => r.statusCode === 201)).toHaveLength(MAX_HOOKS)
      expect(results.filter(r => r.statusCode === 409)).toHaveLength(4)
    })

    it('revokes at once, answers the hook with its date, and a hook of another session is a 404', async () => {
      const hook = await createHook(mine)

      const foreign = await manage('DELETE', other, `/${hook.id}`)
      expect(foreign.statusCode).toBe(404)

      const revoked = await manage('DELETE', mine, `/${hook.id}`)
      expect(revoked.statusCode).toBe(200)
      expect(revoked.json<HookBody>().revokedAt).not.toBeNull()
      expect((await manage('DELETE', mine, `/${hook.id}`)).statusCode).toBe(200)
      expect((await inbound(pathOf(hook), { to: '5215500000001', text: 'hola' })).statusCode).toBe(
        401
      )
    })
  })

  describe('the token route', () => {
    let path = ''
    const sent = () => client(mine).callsOf('sendMessage')

    // A hook of its own for each case: the allowance of a hook is shared by everything sent through it
    beforeEach(async () => {
      path = pathOf(await createHook(mine, 'sender'))
    })
    afterEach(() => revokeAll(mine))

    it('sends through the session of the hook with no API key (short shape)', async () => {
      const before = sent().length

      const response = await inbound(path, { to: '+52 1 55 0000 0001', text: 'hola desde el hook' })

      expect(response.statusCode).toBe(201)
      expect(response.json<{ status: string; message?: { body: string } }>()).toMatchObject({
        status: 'sent',
        message: { body: 'hola desde el hook' }
      })
      expect(sent()).toHaveLength(before + 1)
      expect(client(other).callsOf('sendMessage')).toHaveLength(0)
    })

    it('answers 202 with the job when it is told not to wait', async () => {
      const response = await inbound(`${path}?wait=false`, {
        to: '5215500000007',
        text: 'sin esperar'
      })

      expect(response.statusCode).toBe(202)
      expect(response.json<{ status: string }>().status).toBe('queued')
    })

    it('keeps the idempotency keys of two hooks apart', async () => {
      const key = `inb-${randomUUID()}`
      const body = { to: '5215500000008', text: 'misma llave, otro hook' }
      const anotherPath = pathOf(await createHook(mine, 'another'))

      const first = await inbound(path, body, { 'idempotency-key': key })
      const second = await inbound(anotherPath, body, { 'idempotency-key': key })

      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(201)
      expect(second.headers['idempotent-replayed']).toBeUndefined()
      expect(second.json<{ jobId: string }>().jobId).not.toBe(first.json<{ jobId: string }>().jobId)
    })

    it('takes the body of messages.send too', async () => {
      const response = await inbound(path, { to: '5215500000002', type: 'text', body: 'larga' })

      expect(response.statusCode).toBe(201)
      expect(response.json<{ message?: { body: string } }>().message?.body).toBe('larga')
    })

    it('ignores a session in the body and a key in the headers: the token decides', async () => {
      const refusedBody = await inbound(path, {
        to: '5215500000003',
        type: 'text',
        body: 'x',
        sessionId: other
      })
      expect(refusedBody.statusCode).toBe(400)

      const before = client(other).callsOf('sendMessage').length
      const withKey = await inbound(
        path,
        { to: '5215500000003', text: 'con llave' },
        keys['otherSession']
      )
      expect(withKey.statusCode).toBe(201)
      expect(client(other).callsOf('sendMessage')).toHaveLength(before)
    })

    it('honors Idempotency-Key: the same key and request sends once and says so', async () => {
      const key = `inb-${randomUUID()}`
      const before = sent().length
      const body = { to: '5215500000004', text: 'una sola vez' }

      const first = await inbound(path, body, { 'idempotency-key': key })
      const again = await inbound(path, body, { 'idempotency-key': key })
      const changed = await inbound(
        path,
        { to: '5215500000004', text: 'otra cosa' },
        { 'idempotency-key': key }
      )

      expect(first.statusCode).toBe(201)
      expect(again.statusCode).toBe(201)
      expect(again.headers['idempotent-replayed']).toBe('true')
      expect(again.json<{ jobId: string }>().jobId).toBe(first.json<{ jobId: string }>().jobId)
      expect(changed.statusCode).toBe(422)
      expect(changed.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
      expect(sent()).toHaveLength(before + 1)
    })

    it.each([
      ['an unknown token', `/v1/hooks/inbound/${'A'.repeat(43)}`],
      ['a malformed token', '/v1/hooks/inbound/not-a-token'],
      [
        'a token of the right length with a character that is not base64url',
        `/v1/hooks/inbound/${'A'.repeat(42)}!`
      ],
      ['a token of 100 characters', `/v1/hooks/inbound/${'A'.repeat(100)}`]
    ])('answers the same 401 for %s, whatever the body says', async (_name, url) => {
      // The body is valid: the check of the token comes before the check of the body
      const response = await inbound(url, { to: '', text: '' })

      expect(response.statusCode).toBe(401)
      expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED')
    })

    it('leaves a body over 1 MiB unread (413) even with a valid token', async () => {
      const response = await inbound(path, {
        to: '5215500000005',
        type: 'text',
        body: 'x'.repeat(1024 * 1024 + 1)
      })

      expect(response.statusCode).toBe(413)
    })

    it('does not echo the token in an error', async () => {
      const token = path.split('/').pop() ?? ''
      const response = await inbound(path, { to: '', text: 'x' })

      expect(response.statusCode).toBe(400)
      expect(response.body).not.toContain(token)
    })

    it('limits each hook to INBOUND_HOOK_MAX_PER_MINUTE and says when to retry', async () => {
      const limitedPath = path
      const statuses: number[] = []
      let refused: Awaited<ReturnType<typeof inbound>> | undefined
      for (let i = 0; i < MAX_PER_MINUTE + 2; i += 1) {
        const response = await inbound(limitedPath, { to: '5215500000006', text: `n${i}` })
        statuses.push(response.statusCode)
        if (response.statusCode === 429) refused ??= response
      }

      expect(statuses.filter(status => status === 201)).toHaveLength(MAX_PER_MINUTE)
      expect(statuses.filter(status => status === 429)).toHaveLength(2)
      expect(Number(refused?.headers['retry-after'])).toBeGreaterThan(0)
      expect(refused?.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED')
      // The allowance is the hook's own: another hook of the session still sends
      const another = pathOf(await createHook(mine, 'another'))
      expect((await inbound(another, { to: '5215500000006', text: 'otro hook' })).statusCode).toBe(
        201
      )
    })
  })
})
