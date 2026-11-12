import { Body, Controller, Get, Post } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { AppConfig } from '../../config/env.schema.js'
import { createFastifyAdapter } from '../logger/fastify-adapter.js'

import { applyServerTimeouts, setupHttp } from './http-setup.js'

@Controller('probe')
class ProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true }
  }

  @Post()
  post(@Body() body: unknown): { echoed: unknown } {
    return { echoed: body }
  }
}

describe('setupHttp', () => {
  let app: NestFastifyApplication

  async function bootstrap(config: Pick<AppConfig, 'CORS_ORIGINS' | 'ENABLE_DOCS'>): Promise<void> {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await setupHttp(app, config)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }

  afterEach(async () => {
    await app.close()
  })

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/probe', headers })

  it('adds the security headers', async () => {
    await bootstrap({ CORS_ORIGINS: [], ENABLE_DOCS: false })

    const { headers } = await get()

    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['strict-transport-security']).toBeDefined()
    expect(headers['content-security-policy']).toContain(`default-src 'self'`)
    expect(headers['x-powered-by']).toBeUndefined()
  })

  it('lets Swagger UI load its inline script when the docs are on', async () => {
    await bootstrap({ CORS_ORIGINS: [], ENABLE_DOCS: true })

    const csp = (await get()).headers['content-security-policy']

    expect(csp).toContain(`script-src 'self' https: 'unsafe-inline'`)
  })

  it('answers no CORS header when no origin is listed', async () => {
    await bootstrap({ CORS_ORIGINS: [], ENABLE_DOCS: false })

    const { headers } = await get({ origin: 'https://app.example.com' })

    expect(headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows a listed origin, exposes the request id, and refuses another', async () => {
    await bootstrap({ CORS_ORIGINS: ['https://app.example.com'], ENABLE_DOCS: false })

    const allowed = await get({ origin: 'https://app.example.com' })
    const other = await get({ origin: 'https://evil.example.com' })

    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com')
    expect(allowed.headers['access-control-expose-headers']).toContain('x-request-id')
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
  })

  describe('a NUL character in the request', () => {
    const post = (payload: string) =>
      app.inject({
        method: 'POST',
        url: '/probe',
        headers: { 'content-type': 'application/json' },
        payload
      })

    it.each([
      ['a value', '{"name":"a\\u0000b"}'],
      ['a nested value', '{"a":[{"b":"\\u0000"}]}'],
      ['a key', '{"k\\u0000":1}']
    ])(
      'is answered 400 VALIDATION_ERROR when it is in %s, not left for the database',
      async (_, payload) => {
        await bootstrap({ CORS_ORIGINS: [], ENABLE_DOCS: false })

        const response = await post(payload)

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({
          error: { code: 'VALIDATION_ERROR', requestId: expect.any(String) as unknown }
        })
      }
    )

    it('is refused in the query string too', async () => {
      await bootstrap({ CORS_ORIGINS: [], ENABLE_DOCS: false })

      const response = await app.inject({ method: 'GET', url: '/probe?q=a%00b' })

      expect(response.statusCode).toBe(400)
    })

    it('lets a body without one through', async () => {
      await bootstrap({ CORS_ORIGINS: [], ENABLE_DOCS: false })

      const response = await post('{"name":"ok"}')

      expect(response.statusCode).toBe(201)
      expect(response.json()).toEqual({ echoed: { name: 'ok' } })
    })
  })
})

describe('applyServerTimeouts', () => {
  it('sets the limits of the request, the headers and the idle connection on the Node server', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    const server = app.getHttpServer()
    // Fastify leaves the request timeout off (the failure being fixed)
    expect(server.requestTimeout).toBe(0)

    applyServerTimeouts(server, {
      HTTP_REQUEST_TIMEOUT_MS: 90_000,
      HTTP_HEADERS_TIMEOUT_MS: 20_000,
      HTTP_CONNECTION_TIMEOUT_MS: 45_000
    })

    expect(server.requestTimeout).toBe(90_000)
    expect(server.headersTimeout).toBe(20_000)
    expect(server.timeout).toBe(45_000)
    await app.close()
  })
})
