import { BadRequestException, Controller, Get, Post } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { z } from 'zod'

import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import { createFastifyAdapter } from '../../infra/logger/fastify-adapter.js'
import { ConflictError, InternalError, WhatsAppError } from '../errors.js'

import { AllExceptionsFilter, type ErrorBody } from './all-exceptions.filter.js'

@Controller('probe')
class ProbeController {
  @Get('app-error')
  appError(): never {
    throw new ConflictError('SESSION_NOT_READY', undefined, { sessionId: 'shop', state: 'QR' })
  }

  @Get('whatsapp')
  whatsapp(): never {
    throw new WhatsAppError('WHATSAPP_TIMEOUT', 'getChats timed out after 60000 ms')
  }

  @Get('internal-app-error')
  internalAppError(): never {
    throw new InternalError('INTERNAL', 'pool exhausted at 10.0.0.5')
  }

  @Get('zod')
  zod(): never {
    z.strictObject({ phone: z.string().min(5), text: z.string() }).parse({
      phone: '1',
      extra: true
    })
    throw new Error('unreachable')
  }

  @Get('http-exception')
  httpException(): never {
    throw new BadRequestException('bad shape')
  }

  @Get('unexpected')
  unexpected(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
  }

  @Post('body')
  body(): { ok: true } {
    return { ok: true }
  }
}

describe('AllExceptionsFilter', () => {
  let app: NestFastifyApplication

  async function bootstrap(nodeEnv: AppConfig['NODE_ENV']): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: APP_CONFIG, useValue: { NODE_ENV: nodeEnv } satisfies Partial<AppConfig> },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }
      ]
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    app.useLogger(false)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }

  afterEach(async () => {
    await app.close()
  })

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers })

  describe('in development', () => {
    beforeEach(async () => {
      await bootstrap('development')
    })

    it('answers an AppError with its status, code, message and details', async () => {
      const response = await get('/probe/app-error', { 'x-request-id': 'trace-1' })

      expect(response.statusCode).toBe(409)
      expect(response.json<ErrorBody>()).toEqual({
        error: {
          code: 'SESSION_NOT_READY',
          message: expect.stringContaining('not connected to WhatsApp') as string,
          details: { sessionId: 'shop', state: 'QR' },
          requestId: 'trace-1'
        }
      })
    })

    it('puts the request id in the response header and the body alike', async () => {
      const response = await get('/probe/app-error')

      const { requestId } = response.json<ErrorBody>().error
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
      expect(response.headers['x-request-id']).toBe(requestId)
    })

    it('omits details when the error has none', async () => {
      const response = await get('/probe/whatsapp')

      expect(response.statusCode).toBe(504)
      expect(response.json<ErrorBody>().error).not.toHaveProperty('details')
    })

    it('treats a ZodError nobody mapped as a failure of the gateway, not of the caller', async () => {
      const response = await get('/probe/zod')

      expect(response.statusCode).toBe(500)
      expect(response.json<ErrorBody>().error.code).toBe('INTERNAL')
    })

    it('maps the exceptions Nest raises on its own', async () => {
      const unknownRoute = await get('/probe/nope')
      const badRequest = await get('/probe/http-exception')

      expect(unknownRoute.statusCode).toBe(404)
      expect(unknownRoute.json<ErrorBody>().error.code).toBe('NOT_FOUND')
      expect(badRequest.json<ErrorBody>().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'bad shape'
      })
    })

    it('keeps the status of an error Fastify raises before routing', async () => {
      const malformed = await app.inject({
        method: 'POST',
        url: '/probe/body',
        headers: { 'content-type': 'application/json' },
        payload: '{"broken"'
      })
      const unsupported = await app.inject({
        method: 'POST',
        url: '/probe/body',
        headers: { 'content-type': 'application/x-unknown' },
        payload: 'x'
      })

      expect(malformed.statusCode).toBe(400)
      expect(malformed.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR')
      expect(unsupported.statusCode).toBe(415)
      expect(unsupported.json<ErrorBody>().error.requestId).toBeTruthy()
    })

    it('shows the message of an unexpected failure', async () => {
      const response = await get('/probe/unexpected')

      expect(response.statusCode).toBe(500)
      expect(response.json<ErrorBody>().error).toMatchObject({
        code: 'INTERNAL',
        message: 'connect ECONNREFUSED 10.0.0.5:5432'
      })
    })
  })

  describe('in production', () => {
    beforeEach(async () => {
      await bootstrap('production')
    })

    it('hides the message of an unexpected failure', async () => {
      const response = await get('/probe/unexpected')

      expect(response.statusCode).toBe(500)
      expect(response.json<ErrorBody>().error).toMatchObject({
        code: 'INTERNAL',
        message: 'Internal server error'
      })
      expect(response.body).not.toContain('ECONNREFUSED')
    })

    it('hides the message and the details of an INTERNAL AppError', async () => {
      const response = await get('/probe/internal-app-error')

      expect(response.json<ErrorBody>().error.message).toBe('Internal server error')
      expect(response.body).not.toContain('10.0.0.5')
    })

    it('still shows the message of an error meant for the caller', async () => {
      const response = await get('/probe/app-error')

      expect(response.json<ErrorBody>().error.details).toEqual({ sessionId: 'shop', state: 'QR' })
    })
  })
})
