import { Controller, Get } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import { createFastifyAdapter } from '../../infra/logger/fastify-adapter.js'

import { RequestIdInterceptor } from './request-id.interceptor.js'

@Controller('probe')
class ProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true }
  }
}

describe('RequestIdInterceptor', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }]
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('answers with the id the caller sent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'trace-7' }
    })

    expect(response.headers['x-request-id']).toBe('trace-7')
  })

  it('answers with a generated id when the caller sent none or an unusable one', async () => {
    const none = await app.inject({ method: 'GET', url: '/probe' })
    const unusable = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'has space' }
    })

    expect(none.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    expect(unusable.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })
})
