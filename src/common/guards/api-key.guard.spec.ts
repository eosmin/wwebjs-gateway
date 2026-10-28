import { Controller, Get, HttpException, Req } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import type { ApiKey } from '../../database/models.js'
import { ApiKeysRepository } from '../../database/repositories/api-keys.repository.js'
import { AuthService } from '../../services/auth.service.js'
import { Public, RequireScope } from '../decorators/auth.decorators.js'
import { AppError } from '../errors.js'
import { generateApiKey } from '../lib/crypto.js'

import { type AuthenticatedRequest, ApiKeyGuard } from './api-key.guard.js'

const ADMIN_KEY = 'a'.repeat(32)

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true }
  }

  @RequireScope('read')
  @Get('read')
  read(): { ok: true } {
    return { ok: true }
  }

  @RequireScope('webhooks')
  @Get('webhooks')
  webhooks(): { ok: true } {
    return { ok: true }
  }

  @RequireScope('admin')
  @Get('admin')
  admin(): { ok: true } {
    return { ok: true }
  }

  @RequireScope('read')
  @Get('whoami')
  whoami(@Req() request: AuthenticatedRequest): { keyId: string | null; sessionId: string | null } {
    return {
      keyId: request.principal?.keyId ?? null,
      sessionId: request.principal?.sessionId ?? null
    }
  }

  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true }
  }
}

// The metadata set on the class, which the handlers inherit
@RequireScope('webhooks')
@Controller('class-scoped')
class ClassScopedController {
  @Get()
  get(): { ok: true } {
    return { ok: true }
  }
}

@Public()
@Controller('class-public')
class ClassPublicController {
  @Get()
  get(): { ok: true } {
    return { ok: true }
  }
}

// The error contract is the filter of step 4.2; until it exists the specs read AppError directly
const toHttp = (error: unknown): HttpException =>
  error instanceof AppError
    ? new HttpException({ code: error.code, message: error.message }, error.status)
    : (error as HttpException)

describe('ApiKeyGuard', () => {
  let app: NestFastifyApplication
  let rows: ApiKey[]
  const sender = generateApiKey()
  const revoked = generateApiKey()
  const trusted = generateApiKey()
  const expired = generateApiKey()

  function keyRow(id: string, hash: string, overrides: Partial<ApiKey> = {}): ApiKey {
    return {
      id,
      name: id,
      keyHash: hash,
      keyPrefix: 'wgk_',
      sessionId: 'shop',
      scopes: ['read', 'send'],
      allowedCidrs: [],
      expiresAt: null,
      rotatedFromId: null,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
      ...overrides
    }
  }

  async function bootstrap(trustProxyHops: number): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController, ClassScopedController, ClassPublicController],
      providers: [
        AuthService,
        {
          provide: APP_CONFIG,
          useValue: {
            ADMIN_API_KEY: ADMIN_KEY,
            TRUST_PROXY_HOPS: trustProxyHops
          } satisfies Partial<AppConfig>
        },
        {
          provide: ApiKeysRepository,
          useValue: {
            findByHash: (hash: string): Promise<ApiKey | null> =>
              Promise.resolve(rows.find(candidate => candidate.keyHash === hash) ?? null),
            touchLastUsed: (): Promise<void> => Promise.resolve()
          }
        },
        { provide: APP_GUARD, useClass: ApiKeyGuard }
      ]
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useGlobalFilters({
      catch(error: unknown, host) {
        const http = toHttp(error)
        host
          .switchToHttp()
          .getResponse<{ status(code: number): { send(body: unknown): void } }>()
          .status(http.getStatus())
          .send(http.getResponse())
      }
    })
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }

  beforeEach(() => {
    rows = [
      keyRow('sender', sender.hash),
      keyRow('revoked', revoked.hash, { revokedAt: new Date() }),
      keyRow('trusted', trusted.hash, { allowedCidrs: ['198.51.100.0/24'] }),
      keyRow('expired', expired.hash, { expiresAt: new Date(Date.now() - 1000) })
    ]
  })

  afterEach(async () => {
    await app?.close()
  })

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers })

  describe('without a proxy', () => {
    beforeEach(async () => {
      await bootstrap(0)
    })

    it('leaves a @Public route open', async () => {
      expect((await get('/probe/open')).statusCode).toBe(200)
    })

    it('answers 401 UNAUTHORIZED without a key', async () => {
      const response = await get('/probe/read')

      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' })
    })

    it('accepts the key in X-API-Key and in Authorization: Bearer', async () => {
      expect((await get('/probe/read', { 'x-api-key': sender.raw })).statusCode).toBe(200)
      expect((await get('/probe/read', { authorization: `Bearer ${sender.raw}` })).statusCode).toBe(
        200
      )
    })

    it('rejects another Authorization scheme', async () => {
      const response = await get('/probe/read', { authorization: `Basic ${sender.raw}` })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' })
    })

    it.each([
      ['Bearer a b', 'extra tokens'],
      ['Bearer', 'no token']
    ])('rejects the Authorization header %j (%s)', async header => {
      expect((await get('/probe/read', { authorization: header })).statusCode).toBe(401)
    })

    it('accepts a lowercase bearer scheme', async () => {
      const response = await get('/probe/read', { authorization: `bearer ${sender.raw}` })

      expect(response.statusCode).toBe(200)
    })

    it('prefers X-API-Key over a different Bearer value', async () => {
      const response = await get('/probe/read', {
        'x-api-key': 'wgk_wrong',
        authorization: `Bearer ${sender.raw}`
      })

      expect(response.statusCode).toBe(401)
    })

    it('answers 401 for a revoked key', async () => {
      const response = await get('/probe/read', { 'x-api-key': revoked.raw })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' })
    })

    it('answers 401 API_KEY_EXPIRED for an expired key', async () => {
      const response = await get('/probe/read', { 'x-api-key': expired.raw })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ code: 'API_KEY_EXPIRED' })
    })

    it('answers 401, not 403, for an unknown key on a scoped route', async () => {
      expect((await get('/probe/webhooks', { 'x-api-key': 'wgk_unknown' })).statusCode).toBe(401)
    })

    it('ignores a bad key on a @Public route', async () => {
      expect((await get('/probe/open', { 'x-api-key': 'wgk_unknown' })).statusCode).toBe(200)
    })

    it('attaches the principal to the request', async () => {
      const response = await get('/probe/whoami', { 'x-api-key': sender.raw })

      expect(response.json()).toEqual({ keyId: 'sender', sessionId: 'shop' })
    })

    it('reads the scope and the public flag from the class too', async () => {
      expect((await get('/class-scoped', { 'x-api-key': sender.raw })).statusCode).toBe(403)
      expect((await get('/class-scoped', { 'x-api-key': ADMIN_KEY })).statusCode).toBe(200)
      expect((await get('/class-public')).statusCode).toBe(200)
    })

    it('answers 403 INSUFFICIENT_SCOPE when the key lacks the scope', async () => {
      const response = await get('/probe/webhooks', { 'x-api-key': sender.raw })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
    })

    it('keeps admin-scope routes for admin keys', async () => {
      expect((await get('/probe/admin', { 'x-api-key': sender.raw })).statusCode).toBe(403)
      expect((await get('/probe/admin', { 'x-api-key': ADMIN_KEY })).statusCode).toBe(200)
    })

    it('fails closed on a route that declares no scope', async () => {
      expect((await get('/probe/undeclared', { 'x-api-key': sender.raw })).statusCode).toBe(403)
      expect((await get('/probe/undeclared', { 'x-api-key': ADMIN_KEY })).statusCode).toBe(200)
    })

    it('accepts a peer inside the allowlist (positive control)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/read',
        headers: { 'x-api-key': trusted.raw },
        remoteAddress: '198.51.100.7'
      })

      expect(response.statusCode).toBe(200)
    })

    it('ignores X-Forwarded-For, so a caller cannot pick its own address', async () => {
      const response = await get('/probe/read', {
        'x-api-key': trusted.raw,
        'x-forwarded-for': '198.51.100.7'
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ code: 'IP_NOT_ALLOWED' })
    })
  })

  describe('behind one trusted proxy', () => {
    beforeEach(async () => {
      await bootstrap(1)
    })

    it('judges the address the proxy appended, not the one the caller wrote', async () => {
      const allowed = await get('/probe/read', {
        'x-api-key': trusted.raw,
        'x-forwarded-for': '198.51.100.7'
      })
      const spoofed = await get('/probe/read', {
        'x-api-key': trusted.raw,
        'x-forwarded-for': '198.51.100.7, 203.0.113.9'
      })

      expect(allowed.statusCode).toBe(200)
      expect(spoofed.statusCode).toBe(403)
    })
  })
})
