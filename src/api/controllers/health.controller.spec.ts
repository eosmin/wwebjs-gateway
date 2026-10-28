import { APP_FILTER } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import { UnauthorizedError } from '../../common/errors.js'
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter.js'
import { type Principal, adminPrincipal, keyPrincipal } from '../../common/principal.js'
import { APP_CONFIG } from '../../config/config.module.js'
import { createFastifyAdapter } from '../../infra/logger/fastify-adapter.js'
import { MetricsService } from '../../infra/metrics/metrics.service.js'
import { AuthService } from '../../services/auth.service.js'
import { ReadinessService } from '../../services/readiness.service.js'
import type { HealthResultDto } from '../../types/system.dto.js'

import { HealthController } from './health.controller.js'

const TOKEN = 'scrape-secret-scrape-secret-0123'

describe('HealthController', () => {
  let app: NestFastifyApplication
  const authenticate = jest.fn<Promise<Principal>, [string | undefined, string]>()
  const liveness = jest.fn<Promise<HealthResultDto>, []>()
  const readiness = jest.fn<Promise<HealthResultDto>, []>()

  async function start(metricsToken: string | undefined): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: { METRICS_TOKEN: metricsToken, TRUST_PROXY_HOPS: 0 } },
        { provide: ReadinessService, useValue: { liveness, readiness } },
        { provide: AuthService, useValue: { authenticate } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        MetricsService
      ]
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    app.useLogger(false)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }

  beforeEach(() => {
    authenticate.mockReset().mockRejectedValue(new UnauthorizedError('UNAUTHORIZED'))
    liveness.mockReset().mockResolvedValue({ status: 'ok', details: {} })
    readiness.mockReset().mockResolvedValue({ status: 'ok', details: {} })
  })

  afterEach(async () => {
    await app.close()
  })

  describe('GET /metrics credentials', () => {
    const scrape = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/metrics', headers })

    it('accepts the scrape token without asking the key store', async () => {
      await start(TOKEN)

      const response = await scrape({ authorization: `Bearer ${TOKEN}` })

      expect(response.statusCode).toBe(200)
      expect(authenticate).not.toHaveBeenCalled()
    })

    it.each([
      ['a different token', 'Bearer other'],
      ['a prefix of the token', `Bearer ${TOKEN.slice(0, -1)}`],
      ['the token followed by more', `Bearer ${TOKEN}x`],
      ['the token under another scheme', `Basic ${TOKEN}`]
    ])('refuses %s and falls back to the key store', async (_label, authorization) => {
      await start(TOKEN)

      const response = await scrape({ authorization })

      expect(response.statusCode).toBe(401)
      expect(authenticate).toHaveBeenCalledTimes(1)
    })

    it('refuses a request without credentials', async () => {
      await start(TOKEN)

      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401)
    })

    it('does not accept any bearer when no token is configured', async () => {
      await start(undefined)

      expect((await scrape({ authorization: 'Bearer ' })).statusCode).toBe(401)
      expect((await scrape({ authorization: 'Bearer anything' })).statusCode).toBe(401)
    })

    it('accepts an admin key in X-API-Key', async () => {
      await start(TOKEN)
      authenticate.mockResolvedValue(adminPrincipal(null))

      expect((await scrape({ 'x-api-key': 'k' })).statusCode).toBe(200)
      expect(authenticate).toHaveBeenCalledWith('k', expect.any(String))
    })

    it('accepts an admin key sent as a bearer', async () => {
      await start(TOKEN)
      authenticate.mockResolvedValue(adminPrincipal(null))

      expect((await scrape({ authorization: 'Bearer admin-key' })).statusCode).toBe(200)
      expect(authenticate).toHaveBeenCalledWith('admin-key', expect.any(String))
    })

    it('refuses a session key with INSUFFICIENT_SCOPE', async () => {
      await start(TOKEN)
      authenticate.mockResolvedValue(keyPrincipal('id', 'main', ['read']))

      const response = await scrape({ 'x-api-key': 'k' })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
    })
  })

  describe('probes', () => {
    it.each([
      ['ok', 200],
      ['degraded', 200],
      ['error', 503],
      ['shutting_down', 503]
    ] as const)('answers /ready with %s as %i', async (status, code) => {
      await start(TOKEN)
      readiness.mockResolvedValue({ status, details: {} })

      const response = await app.inject({ method: 'GET', url: '/ready' })

      expect(response.statusCode).toBe(code)
      expect(response.json()).toMatchObject({ status })
    })

    it('answers /health 200 while shutting down, and never looks at the dependencies', async () => {
      await start(TOKEN)
      liveness.mockResolvedValue({ status: 'shutting_down', details: {} })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'shutting_down' })
      expect(readiness).not.toHaveBeenCalled()
    })

    it('needs no credentials', async () => {
      await start(TOKEN)

      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200)
      expect(authenticate).not.toHaveBeenCalled()
    })
  })
})
