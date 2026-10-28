import { Body, Controller, Get, Post } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { OpenAPIObject } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import { Validator } from '@seriousme/openapi-schema-validator'
import { ZodResponse, ZodValidationPipe, createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { ErrorCode } from '../common/errors.js'
import { createFastifyAdapter } from '../infra/logger/fastify-adapter.js'

import { ApiModule } from './api.module.js'
import { DOCS_JSON_PATH, setupDocs } from './openapi.js'
import { WaOperation } from './wa-operation.decorator.js'

class SendTextDto extends createZodDto(
  z.strictObject({
    chatId: z.string().describe('Target chat'),
    text: z.string().min(1).describe('Message body')
  })
) {}

class SentDto extends createZodDto(
  z.strictObject({ messageId: z.string().describe('Id of the sent message') })
) {}

@Controller('v1/probe')
class ProbeController {
  @Post('send')
  @ZodResponse({ status: 201, type: SentDto })
  @WaOperation({
    id: 'messages.sendText',
    scope: 'send',
    summary: 'Send a text message',
    description: 'Queues a text message for the chat.',
    socket: { command: 'messages.sendText' },
    errors: ['VALIDATION_ERROR', 'INSUFFICIENT_SCOPE', 'SESSION_NOT_READY'],
    examples: {
      request: { chatId: '5215500000000@c.us', text: 'hola' },
      response: { messageId: 'true_1' }
    },
    wwebjs: ['Client.sendMessage']
  })
  send(@Body() _body: SendTextDto): SentDto {
    return { messageId: 'true_1' }
  }
}

@Controller('v1/probe')
class StatusController {
  @Get('status')
  @WaOperation({
    id: 'probe.status',
    scope: 'read',
    summary: 'Read the probe status',
    description: 'A gateway-native read with no body.',
    errors: ['SESSION_NOT_READY', 'SESSION_ALREADY_EXISTS'],
    examples: { request: null, response: null },
    wwebjs: [],
    gateway: true
  })
  status(): void {}
}

@Controller('v1/probe')
class ResetController {
  @Post('reset')
  @WaOperation({
    id: 'probe.reset',
    scope: 'manage',
    summary: 'Reset the probe',
    description: 'A POST whose body the example list leaves out.',
    errors: [],
    examples: { request: null, response: { ok: true } },
    wwebjs: [],
    gateway: true
  })
  reset(@Body() _body: SendTextDto): { ok: true } {
    return { ok: true }
  }
}

@Controller('v1/plain')
class PlainController {
  @Get()
  plain(): { ok: true } {
    return { ok: true }
  }
}

describe('setupDocs', () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
      controllers: [ProbeController, StatusController, ResetController, PlainController],
      providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }]
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    app.useLogger(false)
    setupDocs(app, { ENABLE_DOCS: true })
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  async function fetchDocument(): Promise<OpenAPIObject> {
    const response = await app.inject({ method: 'GET', url: `/${DOCS_JSON_PATH}` })
    expect(response.statusCode).toBe(200)
    return response.json<OpenAPIObject>()
  }

  it('serves /docs/json as a valid OpenAPI document', async () => {
    const response = await app.inject({ method: 'GET', url: `/${DOCS_JSON_PATH}` })

    const result = await new Validator().validate(response.json<Record<string, unknown>>())

    expect(result.errors).toBeUndefined()
    expect(result.valid).toBe(true)
  })

  it('names each operation after its registry id and copies the metadata of @WaOperation', async () => {
    const operation = (await fetchDocument()).paths['/v1/probe/send']?.post

    expect(operation).toMatchObject({
      operationId: 'messages.sendText',
      summary: 'Send a text message',
      description: 'Queues a text message for the chat.',
      'x-scope': 'send',
      'x-socket-command': 'messages.sendText',
      'x-wwebjs': ['Client.sendMessage']
    })
  })

  it('adds the examples and the Zod field descriptions', async () => {
    const document = await fetchDocument()
    const operation = document.paths['/v1/probe/send']?.post

    expect(operation?.requestBody).toMatchObject({
      content: { 'application/json': { example: { chatId: '5215500000000@c.us', text: 'hola' } } }
    })
    expect(operation?.responses['201']).toMatchObject({
      content: { 'application/json': { example: { messageId: 'true_1' } } }
    })
    expect(document.components?.schemas?.['SendTextDto']).toMatchObject({
      properties: { text: { description: 'Message body' } }
    })
  })

  it('documents the declared errors under the status each code maps to', async () => {
    const responses = (await fetchDocument()).paths['/v1/probe/send']?.post?.responses

    expect(responses?.['400']).toMatchObject({
      description: expect.stringContaining('VALIDATION_ERROR') as string
    })
    expect(responses?.['403']).toMatchObject({
      description: expect.stringContaining('INSUFFICIENT_SCOPE') as string
    })
    expect(responses?.['409']).toMatchObject({
      description: expect.stringContaining('SESSION_NOT_READY') as string
    })
  })

  it('declares the api key scheme and requires it everywhere', async () => {
    const document = await fetchDocument()

    expect(document.components?.securitySchemes).toEqual({
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' }
    })
    expect(document.security).toEqual([{ apiKey: [] }])
  })

  it('points every error response at ErrorBody and joins the codes that share a status', async () => {
    const document = await fetchDocument()
    const responses = document.paths['/v1/probe/status']?.get?.responses

    expect(responses?.['409']).toMatchObject({
      description: expect.stringMatching(
        /SESSION_NOT_READY[\s\S]*SESSION_ALREADY_EXISTS/
      ) as string,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } }
    })
    expect(document.components?.schemas?.['ErrorBody']).toMatchObject({
      properties: {
        error: {
          properties: { code: { enum: Object.values(ErrorCode) } }
        }
      }
    })
  })

  it('marks a gateway operation and adds nothing it has no data for', async () => {
    const operation = (await fetchDocument()).paths['/v1/probe/status']?.get

    expect(operation).toMatchObject({
      operationId: 'probe.status',
      'x-gateway': true,
      'x-scope': 'read'
    })
    expect(operation).not.toHaveProperty('x-socket-command')
    expect(operation).not.toHaveProperty('requestBody')
    expect(JSON.stringify(operation?.responses['200'])).not.toContain('example')
    expect((await fetchDocument()).paths['/v1/probe/send']?.post).not.toHaveProperty('x-gateway')
  })

  it('adds no request example when the operation declares none for its body', async () => {
    const operation = (await fetchDocument()).paths['/v1/probe/reset']?.post

    expect(operation?.requestBody).toBeDefined()
    expect(JSON.stringify(operation?.requestBody)).not.toContain('example')
  })

  it('leaves a route outside the registry as Nest generated it', async () => {
    const operation = (await fetchDocument()).paths['/v1/plain']?.get

    expect(operation?.operationId).toBe('PlainController.plain')
    expect(operation).not.toHaveProperty('x-scope')
    expect(Object.keys(operation?.responses ?? {})).toEqual(['200'])
  })

  it('does not mount /docs when ENABLE_DOCS is false', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile()
    const off = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    off.useLogger(false)
    try {
      setupDocs(off, { ENABLE_DOCS: false })
      await off.init()
      await off.getHttpAdapter().getInstance().ready()

      expect((await off.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404)
      expect((await off.inject({ method: 'GET', url: `/${DOCS_JSON_PATH}` })).statusCode).toBe(404)
    } finally {
      await off.close()
    }
  })

  it('serves the Swagger UI at /docs', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
  })
})
