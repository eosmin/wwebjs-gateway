import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod'

import { AppModule } from './app.module.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js'
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js'
import { createFastifyAdapter } from './infra/logger/fastify-adapter.js'
import { MetricsService } from './infra/metrics/metrics.service.js'

describe('GET /health', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
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
    expect(response.json()).toEqual({ status: 'ok' })
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

  it('counts the responses in the metrics', async () => {
    await app.inject({ method: 'GET', url: '/health' })

    expect(await app.get(MetricsService).scrape()).toContain(
      'gw_http_requests_total{method="GET",route="/health",status="200"}'
    )
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
