import { Body, Controller, Post } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Validator } from '@seriousme/openapi-schema-validator'
import { ZodResponse, ZodSerializerInterceptor, ZodValidationPipe, createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { buildOpenApiDocument } from './api/openapi.js'
import { OperationRegistryService } from './api/operation-registry.service.js'
import { AppModule } from './app.module.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js'
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js'
import { envSchema } from './config/env.schema.js'
import type { ApiKey } from './database/models.js'
import { PrismaService } from './database/prisma.service.js'
import { type NewApiKey, ApiKeysRepository } from './database/repositories/api-keys.repository.js'
import { SessionsRepository } from './database/repositories/sessions.repository.js'
import { createFastifyAdapter } from './infra/logger/fastify-adapter.js'
import { MetricsService } from './infra/metrics/metrics.service.js'
import { RedisService } from './infra/redis/redis.service.js'
import { AuthService } from './services/auth.service.js'
import { ReconcilerService } from './whatsapp/reconciler.service.js'
import { SessionManager } from './whatsapp/session-manager.service.js'
import { WatchdogService } from './whatsapp/watchdog.service.js'
import {
  WHATSAPP_CLIENT_FACTORY,
  type WhatsAppClientFactory
} from './whatsapp/whatsapp-client.port.js'
import { WwebjsAdapter } from './whatsapp/wwebjs-adapter.js'

const ADMIN = { 'x-api-key': 'a'.repeat(32) }

// Stands in for the table: the specs of the repository run against a real Postgres
class FakeApiKeysRepository {
  readonly rows = new Map<string, ApiKey>()

  create(data: NewApiKey): Promise<ApiKey> {
    const row: ApiKey = {
      id: crypto.randomUUID(),
      name: data.name,
      keyHash: data.keyHash,
      keyPrefix: data.keyPrefix,
      sessionId: data.sessionId ?? null,
      scopes: data.scopes,
      allowedCidrs: data.allowedCidrs ?? [],
      expiresAt: data.expiresAt ?? null,
      rotatedFromId: data.rotatedFromId ?? null,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null
    }
    this.rows.set(row.id, row)
    return Promise.resolve(row)
  }

  findById(id: string): Promise<ApiKey | null> {
    return Promise.resolve(this.rows.get(id) ?? null)
  }

  findByHash(keyHash: string): Promise<ApiKey | null> {
    return Promise.resolve([...this.rows.values()].find(r => r.keyHash === keyHash) ?? null)
  }

  list(): Promise<ApiKey[]> {
    return Promise.resolve([...this.rows.values()])
  }

  touchLastUsed(): Promise<void> {
    return Promise.resolve()
  }

  revoke(id: string, at: Date): Promise<ApiKey | null> {
    const row = this.rows.get(id)
    if (row !== undefined) row.revokedAt ??= at
    return Promise.resolve(row ?? null)
  }

  async rotate(
    oldId: string,
    replacement: (old: ApiKey) => NewApiKey,
    oldExpiresAt: Date
  ): Promise<ApiKey | null> {
    const old = this.rows.get(oldId)
    if (old === undefined || old.revokedAt !== null) return null
    // Never later than the date the key already had, as the repository does
    old.expiresAt =
      old.expiresAt !== null && old.expiresAt < oldExpiresAt ? old.expiresAt : oldExpiresAt
    return this.create({ ...replacement(old), rotatedFromId: oldId })
  }
}

class ExtraFieldDto extends createZodDto(z.object({ visible: z.string() })) {}
class ProbeBodyDto extends createZodDto(z.strictObject({ count: z.number().int() })) {}

@Controller('probe')
class ProbeController {
  @Post('validate')
  validate(@Body() body: ProbeBodyDto): ProbeBodyDto {
    return body
  }

  @Post('strip')
  @ZodResponse({ type: ExtraFieldDto })
  strip(): ExtraFieldDto {
    return { visible: 'yes', secret: 'no' } as ExtraFieldDto // reason: the extra field is what the test needs
  }
}

describe('AppModule over HTTP', () => {
  let app: NestFastifyApplication
  const queryRaw = jest.fn()
  const ping = jest.fn()
  const keys = new FakeApiKeysRepository()

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController]
    })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: queryRaw })
      .overrideProvider(RedisService)
      .useValue({ client: { ping } })
      .overrideProvider(ApiKeysRepository)
      .useValue(keys)
      .overrideProvider(SessionsRepository)
      .useValue({
        findById: (id: string) => Promise.resolve(id === 'main' ? { id } : null),
        listAutoStart: () => Promise.resolve([]),
        update: () => Promise.resolve(null),
        list: () =>
          Promise.resolve([
            { id: 'main', status: 'ready' },
            { id: 'sales', status: 'qr' },
            { id: 'support', status: 'ready' }
          ])
      })
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('answers 200 with the liveness body', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ok' })
  })

  it('answers with the request id the caller sent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-9' }
    })

    expect(response.headers['x-request-id']).toBe('trace-9')
  })

  it('answers an unknown route with the error contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', requestId: response.headers['x-request-id'] }
    })
  })

  it('limits a caller that keeps sending unknown keys before any key is looked up', async () => {
    const send = () =>
      app.inject({
        method: 'GET',
        url: '/v1/api-keys',
        headers: { 'x-api-key': 'wgk_unknown' },
        remoteAddress: '192.0.2.50'
      })
    const lookups = jest.spyOn(keys, 'findByHash')

    for (let i = 0; i < envSchema.shape.RATE_LIMIT_MAX.parse(undefined); i++) await send()
    const refused = await send()

    expect(refused.statusCode).toBe(429)
    expect(refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(lookups).toHaveBeenCalledTimes(envSchema.shape.RATE_LIMIT_MAX.parse(undefined))
    lookups.mockRestore()
  })

  it('counts the responses in the metrics', async () => {
    await app.inject({ method: 'GET', url: '/health' })

    expect(await app.get(MetricsService).scrape()).toContain(
      'gw_http_requests_total{method="GET",route="/health",status="200"}'
    )
  })

  describe('GET /ready', () => {
    beforeEach(() => {
      queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }])
      ping.mockReset().mockResolvedValue('PONG')
    })

    it('answers 200 without a key when Postgres and Redis answer', async () => {
      const response = await app.inject({ method: 'GET', url: '/ready' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        status: 'ok',
        details: { postgres: { status: 'up' }, redis: { status: 'up' } }
      })
    })

    it('answers 503 and names Postgres when it does not answer, while /health stays 200', async () => {
      queryRaw.mockRejectedValue(new Error('connection refused'))

      const response = await app.inject({ method: 'GET', url: '/ready' })

      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({
        status: 'error',
        error: { postgres: { status: 'down' } },
        info: { redis: { status: 'up' } }
      })
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    })

    it('answers 503 and names Redis when it does not answer', async () => {
      ping.mockRejectedValue(new Error('connection refused'))

      const response = await app.inject({ method: 'GET', url: '/ready' })

      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({
        status: 'error',
        error: { redis: { status: 'down' } }
      })
    })
  })

  describe('GET /metrics', () => {
    it('refuses a request without credentials', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' })

      expect(response.statusCode).toBe(401)
    })

    it('serves the series to an admin key', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics', headers: ADMIN })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/plain')
      expect(response.body).toContain('# TYPE gw_sessions ')
    })
  })

  describe('the global pipe and serializer', () => {
    it('answers 400 VALIDATION_ERROR for a body that breaks the schema of its DTO', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/probe/validate',
        headers: ADMIN,
        payload: { count: 'many' }
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    })

    it('strips from a @ZodResponse the field its schema does not list', async () => {
      const response = await app.inject({ method: 'POST', url: '/probe/strip', headers: ADMIN })

      expect(response.json()).toEqual({ visible: 'yes' })
    })
  })

  describe('GET /v1/system/info', () => {
    it('reports versions and counts the sessions by status', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/system/info', headers: ADMIN })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        wwebjsVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string,
        sessions: { total: 3, byStatus: { ready: 2, qr: 1, failed: 0 } }
      })
    })

    it('is closed to a session key', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: ADMIN,
        payload: { name: 'bot', sessionId: 'main' }
      })

      const response = await app.inject({
        method: 'GET',
        url: '/v1/system/info',
        headers: { 'x-api-key': created.json<{ key: string }>().key }
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
    })
  })

  describe('the OpenAPI document', () => {
    it('is a valid OpenAPI document that names every operation of the controllers', async () => {
      const document = buildOpenApiDocument(app, app.get(OperationRegistryService))

      // The same trip through JSON that /docs/json makes
      const served = JSON.parse(JSON.stringify(document)) as Record<string, unknown>
      const result = await new Validator().validate(served)

      expect(result.errors).toBeUndefined()
      expect(document.paths['/v1/api-keys']?.get?.operationId).toBe('apiKeys.list')
      expect(document.paths['/v1/api-keys']?.post?.operationId).toBe('apiKeys.create')
      expect(document.paths['/v1/system/info']?.get?.operationId).toBe('system.info')
      expect(document.paths['/v1/sessions']?.post?.operationId).toBe('sessions.create')
      expect(document.paths['/v1/sessions/{sessionId}/qr']?.get?.operationId).toBe('sessions.qr')
      expect(document.paths['/v1/sessions/{sessionId}/qr.png']?.get?.operationId).toBe(
        'sessions.qrPng'
      )
      // The scope of the QR routes is part of the published contract
      expect(document.paths['/v1/sessions/{sessionId}/qr']?.get).toMatchObject({
        'x-scope': 'manage'
      })
      expect(document.paths['/v1/sessions/{sessionId}/qr.png']?.get).toMatchObject({
        'x-scope': 'manage'
      })
    })

    it('asks for no key on the probes and the scrape route, and for one on the rest', () => {
      const { paths } = buildOpenApiDocument(app, app.get(OperationRegistryService))

      for (const path of ['/health', '/ready', '/metrics']) {
        expect(paths[path]?.get?.security).toEqual([])
      }
      expect(paths['/v1/api-keys']?.get).not.toHaveProperty('security')
      expect(paths['/v1/system/info']?.get).not.toHaveProperty('security')
    })
  })

  describe('the sessions module', () => {
    it('runs the manager, the watchdog and the reconciler as providers of the application', () => {
      expect(app.get(SessionManager)).toBeInstanceOf(SessionManager)
      expect(app.get(WatchdogService)).toBeInstanceOf(WatchdogService)
      expect(app.get(ReconcilerService)).toBeInstanceOf(ReconcilerService)
    })

    it('resolves the client factory to the real one, whose clients do not launch a browser', () => {
      const factory = app.get<WhatsAppClientFactory>(WHATSAPP_CLIENT_FACTORY)

      // Building a client only configures wwebjs; the browser starts with initialize()
      expect(factory('probe', {})).toBeInstanceOf(WwebjsAdapter)
    })

    it('asks for a key on every route', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/sessions' })

      expect(response.statusCode).toBe(401)
    })

    it('answers 404 with the error contract for the QR code of a session that does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/ghost/qr.png',
        headers: ADMIN
      })

      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    })

    it('answers 400 for a session id that breaks the pattern', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/bad.id/qr',
        headers: ADMIN
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    })

    it('answers 403 before it looks at the id when a session key names another session', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: ADMIN,
        payload: { name: 'bot', sessionId: 'main' }
      })

      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/bad.id/qr',
        headers: { 'x-api-key': created.json<{ key: string }>().key }
      })

      expect(response.statusCode).toBe(403)
    })

    it('closes the list and the creation to a session key', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: ADMIN,
        payload: { name: 'bot', sessionId: 'main', scopes: ['read', 'manage'] }
      })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { 'x-api-key': created.json<{ key: string }>().key },
        payload: { id: 'new' }
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
    })

    it('keeps a session key out of another session', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: ADMIN,
        payload: { name: 'bot', sessionId: 'main' }
      })

      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions/sales',
        headers: { 'x-api-key': created.json<{ key: string }>().key }
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    })
  })

  describe('/v1/api-keys', () => {
    const post = (url: string, payload?: object, headers: Record<string, string> = ADMIN) =>
      app.inject({ method: 'POST', url, headers, ...(payload && { payload }) })

    it('creates a key, shows the raw key once and never lists it', async () => {
      const created = await post('/v1/api-keys', { name: 'bot', sessionId: 'main' })
      const body = created.json<{ id: string; key: string; scopes: string[] }>()

      expect(created.statusCode).toBe(201)
      expect(body.key).toMatch(/^wgk_/)
      expect(body.scopes).toEqual(['read', 'send', 'events'])

      const listing = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: ADMIN })

      expect(listing.statusCode).toBe(200)
      expect(listing.body).not.toContain(body.key)
      expect(listing.body).not.toContain('keyHash')
      expect(listing.json<{ keys: { id: string }[] }>().keys.map(k => k.id)).toContain(body.id)
    })

    it('makes a key without a session an admin key', async () => {
      const created = await post('/v1/api-keys', { name: 'ops' })

      const response = await app.inject({
        method: 'GET',
        url: '/v1/api-keys',
        headers: { 'x-api-key': created.json<{ key: string }>().key }
      })

      expect(response.statusCode).toBe(200)
    })

    it.each([
      ['POST', '/v1/api-keys', { name: 'x' }],
      ['GET', '/v1/api-keys', undefined],
      ['POST', '/v1/api-keys/00000000-0000-4000-8000-000000000000/rotate', undefined],
      ['DELETE', '/v1/api-keys/00000000-0000-4000-8000-000000000000', undefined],
      ['GET', '/v1/system/info', undefined]
    ] as const)('keeps a session key out of %s %s', async (method, url, payload) => {
      const created = await post('/v1/api-keys', { name: 'bot', sessionId: 'main' })

      const response = await app.inject({
        method,
        url,
        headers: { 'x-api-key': created.json<{ key: string }>().key },
        ...(payload && { payload })
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
    })

    it.each([
      ['an address list entry that is not an address', { name: 'x', allowedCidrs: ['nope'] }],
      ['a scope no key can hold', { name: 'x', sessionId: 'main', scopes: ['admin'] }],
      ['an expiry in the past', { name: 'x', expiresAt: '2020-01-01T00:00:00.000Z' }],
      ['scopes on a key without a session', { name: 'x', scopes: ['read'] }],
      ['an unknown field', { name: 'x', extra: true }]
    ])('refuses %s', async (_label, payload) => {
      const response = await post('/v1/api-keys', payload)

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    })

    it('answers 404 for a session that does not exist', async () => {
      const response = await post('/v1/api-keys', { name: 'x', sessionId: 'ghost' })

      expect(response.statusCode).toBe(404)
    })

    it('rotates: the new key works and the old one lives for the grace period only', async () => {
      const created = (await post('/v1/api-keys', { name: 'bot', sessionId: 'main' })).json<{
        id: string
        key: string
      }>()

      const rotated = await post(`/v1/api-keys/${created.id}/rotate`)
      const body = rotated.json<{
        id: string
        key: string
        rotatedFromId: string
        sessionId: string
        previousKeyExpiresAt: string
      }>()

      expect(rotated.statusCode).toBe(201)
      expect(body).toMatchObject({ rotatedFromId: created.id, sessionId: 'main' })
      expect(body.key).not.toBe(created.key)
      const stored = (await keys.findById(created.id))?.expiresAt
      expect(stored?.toISOString()).toBe(body.previousKeyExpiresAt)
      const graceMs = new Date(body.previousKeyExpiresAt).getTime() - Date.now()
      expect(graceMs).toBeGreaterThan(9 * 60_000)
      expect(graceMs).toBeLessThanOrEqual(10 * 60_000)
      const read = (key: string) =>
        app.inject({ method: 'GET', url: '/v1/system/info', headers: { 'x-api-key': key } })
      // Both reach the guard (403: a session key is not admin), neither is a 401
      expect((await read(created.key)).statusCode).toBe(403)
      expect((await read(body.key)).statusCode).toBe(403)

      const oldRow = await keys.findById(created.id)
      if (oldRow === null) throw new Error('the rotated key vanished')
      oldRow.expiresAt = new Date(Date.now() - 1000)
      app.get(AuthService).invalidate(created.id)

      expect((await read(created.key)).statusCode).toBe(401)
      expect((await read(body.key)).statusCode).toBe(403)
    })

    it('answers 404 when rotating or revoking a key that does not exist, 400 for a bad id', async () => {
      const missing = '00000000-0000-4000-8000-000000000000'

      expect((await post(`/v1/api-keys/${missing}/rotate`)).statusCode).toBe(404)
      expect(
        (await app.inject({ method: 'DELETE', url: `/v1/api-keys/${missing}`, headers: ADMIN }))
          .statusCode
      ).toBe(404)
      expect((await post('/v1/api-keys/not-a-uuid/rotate')).statusCode).toBe(400)
    })

    it('revokes: the key stops working at once and a second revoke keeps the first date', async () => {
      const created = (await post('/v1/api-keys', { name: 'ops' })).json<{
        id: string
        key: string
      }>()
      const use = () =>
        app.inject({ method: 'GET', url: '/v1/api-keys', headers: { 'x-api-key': created.key } })
      expect((await use()).statusCode).toBe(200)

      const first = await app.inject({
        method: 'DELETE',
        url: `/v1/api-keys/${created.id}`,
        headers: ADMIN
      })
      const second = await app.inject({
        method: 'DELETE',
        url: `/v1/api-keys/${created.id}`,
        headers: ADMIN
      })

      expect(first.statusCode).toBe(200)
      expect(first.json<{ revokedAt: string }>().revokedAt).toBeTruthy()
      expect(second.json<{ revokedAt: string }>().revokedAt).toBe(
        first.json<{ revokedAt: string }>().revokedAt
      )
      expect((await use()).statusCode).toBe(401)
    })
  })

  it.each([
    [APP_PIPE, ZodValidationPipe],
    [APP_FILTER, AllExceptionsFilter],
    [APP_INTERCEPTOR, RequestIdInterceptor],
    [APP_INTERCEPTOR, TimeoutInterceptor],
    [APP_INTERCEPTOR, ZodSerializerInterceptor]
  ])('registers %p with %p globally', (token, implementation) => {
    const providers = Reflect.getMetadata('providers', AppModule) as {
      provide?: unknown
      useClass?: unknown
    }[]

    expect(providers).toContainEqual({ provide: token, useClass: implementation })
  })
})
