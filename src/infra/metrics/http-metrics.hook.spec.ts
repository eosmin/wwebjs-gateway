import { Controller, Get, HttpCode, Post } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import { ConflictError, UnauthorizedError } from '../../common/errors.js'
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter.js'
import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import { createFastifyAdapter } from '../logger/fastify-adapter.js'

import { MetricsModule } from './metrics.module.js'
import { MetricsService } from './metrics.service.js'

@Controller('probe')
class ProbeController {
  @Get('metered/:id')
  metered(): { ok: true } {
    return { ok: true }
  }

  @Post('created')
  created(): { ok: true } {
    return { ok: true }
  }

  @HttpCode(202)
  @Post('accepted')
  accepted(): { ok: true } {
    return { ok: true }
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictError('SESSION_NOT_READY')
  }

  @Get('slow')
  slow(): Promise<{ ok: true }> {
    return new Promise(resolve => setTimeout(() => resolve({ ok: true }), 80))
  }

  @Get('guarded')
  guarded(): { ok: true } {
    return { ok: true }
  }
}

describe('HttpMetricsHook', () => {
  let app: NestFastifyApplication
  let metrics: MetricsService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MetricsModule],
      controllers: [ProbeController],
      providers: [
        { provide: APP_CONFIG, useValue: { NODE_ENV: 'test' } satisfies Partial<AppConfig> },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate: (context: { switchToHttp(): { getRequest(): { url: string } } }) => {
              if (context.switchToHttp().getRequest().url === '/probe/guarded') {
                throw new UnauthorizedError('UNAUTHORIZED')
              }
              return true
            }
          }
        }
      ]
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    app.useLogger(false)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    metrics = moduleRef.get(MetricsService)
  })

  afterAll(async () => {
    await app.close()
  })

  // The series are shared by the specs below, so each one uses a route of its own
  it('counts by route pattern, so two ids are one series', async () => {
    await app.inject({ method: 'GET', url: '/probe/metered/1' })
    await app.inject({ method: 'GET', url: '/probe/metered/2' })

    const body = await metrics.scrape()
    expect(body).toContain(
      'gw_http_requests_total{method="GET",route="/probe/metered/:id",status="200"} 2'
    )
    expect(body).toContain(
      'gw_http_request_duration_seconds_count{method="GET",route="/probe/metered/:id"} 2'
    )
  })

  it('records the status the response ends with', async () => {
    await app.inject({ method: 'POST', url: '/probe/created' })
    await app.inject({ method: 'POST', url: '/probe/accepted' })
    await app.inject({ method: 'GET', url: '/probe/conflict' })

    const body = await metrics.scrape()
    expect(body).toContain('route="/probe/created",status="201"} 1')
    expect(body).toContain('route="/probe/accepted",status="202"} 1')
    expect(body).toContain('route="/probe/conflict",status="409"} 1')
  })

  it('measures the duration in seconds', async () => {
    await app.inject({ method: 'GET', url: '/probe/slow' })

    const body = await metrics.scrape()
    const sum =
      /gw_http_request_duration_seconds_sum\{method="GET",route="\/probe\/slow"\} (\S+)/.exec(body)
    expect(Number(sum?.[1])).toBeGreaterThanOrEqual(0.07)
    expect(Number(sum?.[1])).toBeLessThan(5)
  })

  it('counts a request a guard rejects', async () => {
    await app.inject({ method: 'GET', url: '/probe/guarded' })

    expect(await metrics.scrape()).toContain('route="/probe/guarded",status="401"} 1')
  })

  it('counts a request no route matched under one label, whatever the URL', async () => {
    await app.inject({ method: 'GET', url: '/nothing/1' })
    await app.inject({ method: 'GET', url: '/nothing/2' })

    expect(await metrics.scrape()).toContain(
      'gw_http_requests_total{method="GET",route="unmatched",status="404"} 2'
    )
  })
})
