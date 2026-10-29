import { Controller, Get } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { AppConfig } from '../../config/env.schema.js'
import { createFastifyAdapter } from '../logger/fastify-adapter.js'

import { setupHttp } from './http-setup.js'

@Controller('probe')
class ProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true }
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
})
