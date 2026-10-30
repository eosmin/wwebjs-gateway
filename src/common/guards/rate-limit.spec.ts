import { type ExecutionContext, Controller, Get, Global, Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import { RateLimitModule } from '../../api/rate-limit.module.js'
import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import { ApiKeysRepository } from '../../database/repositories/api-keys.repository.js'
import { AuthModule } from '../../services/auth.module.js'
import { Public, RequireScope } from '../decorators/auth.decorators.js'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter.js'

import { buildRateLimitOptions } from './rate-limit.js'

const ADMIN_KEY = 'a'.repeat(32)
const LIMIT = 3

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
}

describe('the rate limit', () => {
  let app: NestFastifyApplication
  const findByHash = jest.fn()

  // ConfigModule is global in the application; the modules under test read the config the same way
  function configModule(trustProxyHops: number): new () => object {
    const config = {
      NODE_ENV: 'test',
      ADMIN_API_KEY: ADMIN_KEY,
      RATE_LIMIT_MAX: LIMIT,
      TRUST_PROXY_HOPS: trustProxyHops
    } satisfies Partial<AppConfig>
    @Global()
    @Module({
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ApiKeysRepository, useValue: { findByHash, touchLastUsed: jest.fn() } }
      ],
      exports: [APP_CONFIG, ApiKeysRepository]
    })
    class TestConfigModule {}
    return TestConfigModule
  }

  async function bootstrap(trustProxyHops = 0): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      // Guards run in the order their modules are registered: the limit comes before the API key, as in AppModule
      imports: [configModule(trustProxyHops), RateLimitModule, AuthModule],
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }]
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }

  beforeEach(() => {
    findByHash.mockReset().mockResolvedValue(null)
  })

  afterEach(async () => {
    await app?.close()
  })

  const get = (url: string, headers: Record<string, string> = {}, remoteAddress = '10.0.0.1') =>
    app.inject({ method: 'GET', url, headers, remoteAddress })

  describe('on the public routes', () => {
    beforeEach(() => bootstrap())

    it('lets RATE_LIMIT_MAX requests through and refuses the next with the error contract', async () => {
      for (let i = 0; i < LIMIT; i++) {
        expect((await get('/probe/open')).statusCode).toBe(200)
      }

      const refused = await get('/probe/open')

      expect(refused.statusCode).toBe(429)
      expect(refused.json<{ error: { code: string; requestId: string } }>().error).toEqual({
        code: 'RATE_LIMITED',
        message: expect.stringContaining('Retry-After') as string,
        requestId: refused.headers['x-request-id']
      })
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
      expect(Object.keys(refused.headers).filter(h => h.startsWith('x-ratelimit'))).toEqual([])
    })

    it('counts each address on its own', async () => {
      for (let i = 0; i < LIMIT; i++) await get('/probe/open')

      expect((await get('/probe/open', {}, '10.0.0.2')).statusCode).toBe(200)
    })

    it('counts every route against the same allowance', async () => {
      await get('/probe/open')
      await get('/probe/open')
      await get('/probe/read', { 'x-api-key': ADMIN_KEY })

      expect((await get('/probe/open')).statusCode).toBe(429)
    })
  })

  describe('addresses', () => {
    beforeEach(() => bootstrap())

    it('counts the addresses of one IPv6 /64 as one caller', async () => {
      for (let i = 0; i < LIMIT; i++) await get('/probe/open', {}, `2001:db8:1:2::${i + 1}`)

      expect((await get('/probe/open', {}, '2001:db8:1:2:ffff::9')).statusCode).toBe(429)
      expect((await get('/probe/open', {}, '2001:db8:1:3::1')).statusCode).toBe(200)
    })

    it('counts an IPv4-mapped IPv6 address as its IPv4 address', async () => {
      for (let i = 0; i < LIMIT; i++) await get('/probe/open', {}, '203.0.113.9')

      expect((await get('/probe/open', {}, '::ffff:203.0.113.9')).statusCode).toBe(429)
    })
  })

  describe('on the failed authentications', () => {
    beforeEach(() => bootstrap())

    it('refuses before the key is looked up, even when each request carries a new key', async () => {
      for (let i = 0; i < LIMIT; i++) {
        expect((await get('/probe/read', { 'x-api-key': `wgk_unknown_${i}` })).statusCode).toBe(401)
      }
      expect(findByHash).toHaveBeenCalledTimes(LIMIT)

      const refused = await get('/probe/read', { 'x-api-key': 'wgk_unknown_next' })

      expect(refused.statusCode).toBe(429)
      expect(findByHash).toHaveBeenCalledTimes(LIMIT)
    })
  })

  describe('per API key', () => {
    beforeEach(() => bootstrap())

    it('keeps the allowance of a key whatever the address it comes from', async () => {
      const headers = { 'x-api-key': ADMIN_KEY }
      for (let i = 0; i < LIMIT; i++) {
        expect((await get('/probe/read', headers, `10.0.1.${i}`)).statusCode).toBe(200)
      }

      expect((await get('/probe/read', headers, '10.0.1.9')).statusCode).toBe(429)
    })

    it('does not charge a key for the requests of another', async () => {
      for (let i = 0; i < LIMIT; i++) await get('/probe/read', { 'x-api-key': ADMIN_KEY })

      const other = await get(
        '/probe/read',
        { authorization: `Bearer ${'b'.repeat(32)}` },
        '10.0.0.7'
      )

      expect(other.statusCode).toBe(401)
    })
  })

  describe('behind a proxy', () => {
    beforeEach(() => bootstrap(1))

    it('tells clients apart by the address the proxy saw, not by the proxy', async () => {
      const proxy = '10.9.9.9'
      for (let i = 0; i < LIMIT; i++) {
        await get('/probe/open', { 'x-forwarded-for': '203.0.113.5' }, proxy)
      }

      expect(
        (await get('/probe/open', { 'x-forwarded-for': '203.0.113.5' }, proxy)).statusCode
      ).toBe(429)
      expect(
        (await get('/probe/open', { 'x-forwarded-for': '203.0.113.6' }, proxy)).statusCode
      ).toBe(200)
    })
  })
})

describe('the address bucket of a request the large-body hook already counted', () => {
  const options = buildRateLimitOptions({ RATE_LIMIT_MAX: 5, TRUST_PROXY_HOPS: 0 })
  const addressBucket = (): { skipIf?: (context: ExecutionContext) => boolean } => {
    const throttlers = Array.isArray(options) ? options : options.throttlers
    const found = throttlers.find(throttler => throttler.name === 'ip')
    if (!found) throw new Error('no address bucket')
    return found
  }
  const contextOf = (request: object): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext

  it('is skipped by the guard, so a large send costs one hit and not two', () => {
    expect(addressBucket().skipIf?.(contextOf({ ipRateCounted: true }))).toBe(true)
  })

  it('is counted by the guard for every other request', () => {
    expect(addressBucket().skipIf?.(contextOf({ headers: {} }))).toBe(false)
  })
})
