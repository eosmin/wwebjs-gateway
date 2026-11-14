import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ZodResponse, createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { ApiModule } from '../api/api.module.js'
import { WaOperation } from '../api/wa-operation.decorator.js'
import type { WaOperationMeta } from '../api/wa-operation.schema.js'
import { CurrentPrincipal } from '../common/decorators/auth.decorators.js'
import { AppError } from '../common/errors.js'
import { describeException } from '../common/filters/all-exceptions.filter.js'
import { type Principal, adminPrincipal, keyPrincipal } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import { parseEnv } from '../config/env.schema.js'

import { OperationDispatcherService } from './operation-dispatcher.service.js'

class StateParams extends createZodDto(
  z.strictObject({ sessionId: z.string(), chatId: z.string() })
) {}
class StateBody extends createZodDto(
  z.strictObject({ state: z.enum(['typing', 'clear']), durationMs: z.number().int().optional() })
) {}
class ListQuery extends createZodDto(
  z.strictObject({ limit: z.coerce.number().int().optional() })
) {}
class ChatDto extends createZodDto(z.object({ id: z.string() })) {}

const meta = (id: string, command: string, scope: WaOperationMeta['scope']): WaOperationMeta => ({
  id,
  scope,
  summary: 'A test operation',
  description: 'A test operation.',
  socket: { command },
  errors: [],
  examples: { request: null, response: null },
  wwebjs: [],
  gateway: true
})

const calls: { op: string; args: unknown[] }[] = []

@Controller('v1/sessions')
class FakeController {
  @Post(':sessionId/chats/:chatId/state')
  @WaOperation(meta('fake.state', 'fake.state', 'send'))
  state(@Param() params: StateParams, @Body() body: StateBody): Promise<void> {
    calls.push({ op: 'state', args: [params, body] })
    return Promise.resolve()
  }

  @Get(':sessionId/chats')
  @WaOperation(meta('fake.list', 'fake.list', 'read'))
  @ZodResponse({ type: ChatDto })
  list(@Param('sessionId') sessionId: string, @Query() query: ListQuery): ChatDto {
    calls.push({ op: 'list', args: [sessionId, query] })
    // `secret` is not part of the response schema: the serializer must drop it
    return { id: 'chat-1', secret: 'must not leave' } as ChatDto
  }

  @Post(':sessionId/echo')
  @WaOperation(meta('fake.echo', 'fake.echo', 'send'))
  echo(
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) reply: { status: (code: number) => unknown }
  ): unknown {
    reply.status(202)
    calls.push({ op: 'echo', args: [sessionId, body, key] })
    return { sessionId, key: key ?? null }
  }

  // Not tied to a session: the operation decides by the principal, as the webhooks routes do
  @Post('who-am-i')
  @WaOperation(meta('fake.whoAmI', 'fake.whoAmI', 'webhooks'))
  whoAmI(@CurrentPrincipal() principal: Principal): unknown {
    return { sessionId: principal.sessionId, admin: principal.isAdmin }
  }

  @Post('system/reset')
  @WaOperation(meta('fake.reset', 'fake.reset', 'admin'))
  reset(): void {
    calls.push({ op: 'reset', args: [] })
  }
}

@Controller('v1/broken')
class BrokenController {
  @Get('x')
  @WaOperation(meta('broken.op', 'broken.op', 'read'))
  op(@Req() request: unknown): unknown {
    return request
  }
}

async function build(
  ...controllers: (typeof FakeController | typeof BrokenController)[]
): Promise<OperationDispatcherService> {
  const module = await Test.createTestingModule({
    imports: [ApiModule],
    controllers,
    providers: [OperationDispatcherService, { provide: APP_CONFIG, useValue: parseEnv(TEST_ENV) }]
  }).compile()
  await module.init()
  return module.get(OperationDispatcherService)
}

const sessionKey = (sessionId: string, ...scopes: string[]): Principal =>
  keyPrincipal('key-1', sessionId, scopes)

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  if (!(error instanceof Error)) throw new Error('the command should have failed')
  return error as AppError
}

describe('OperationDispatcherService', () => {
  let dispatcher: OperationDispatcherService

  beforeEach(async () => {
    calls.length = 0
    dispatcher = await build(FakeController)
  })

  it('lists the socket commands of the registry', () => {
    expect(dispatcher.commands()).toEqual(
      expect.arrayContaining(['fake.state', 'fake.list', 'fake.echo', 'fake.whoAmI', 'fake.reset'])
    )
  })

  it('runs the controller method with the path, the body and the checked session', async () => {
    const result = await dispatcher.dispatch(sessionKey('sales', 'send'), {
      op: 'fake.state',
      sessionId: 'sales',
      params: { chatId: '5215512345678@c.us', state: 'typing', durationMs: 3000 }
    })

    expect(result).toBeNull()
    expect(calls).toEqual([
      {
        op: 'state',
        args: [
          { sessionId: 'sales', chatId: '5215512345678@c.us' },
          { state: 'typing', durationMs: 3000 }
        ]
      }
    ])
  })

  it('takes the rest of params as the query of a read, validated, and serializes the answer', async () => {
    const result = await dispatcher.dispatch(sessionKey('sales', 'read'), {
      op: 'fake.list',
      sessionId: 'sales',
      params: { limit: 5 }
    })

    // The query went through the pipe (the number is a number) and `secret` did not leave
    expect(result).toEqual({ id: 'chat-1' })
    expect(calls[0]?.args).toEqual(['sales', { limit: 5 }])
  })

  it('answers a body that does not fit its schema as VALIDATION_ERROR and runs nothing', async () => {
    const error = await failure(
      dispatcher.dispatch(sessionKey('sales', 'send'), {
        op: 'fake.state',
        sessionId: 'sales',
        params: { chatId: 'c', state: 'dancing' }
      })
    )

    expect(describeException(error, false).code).toBe('VALIDATION_ERROR')
    expect(calls).toEqual([])
  })

  it('refuses a session the key cannot reach, before the method runs', async () => {
    const error = await failure(
      dispatcher.dispatch(sessionKey('sales', 'send'), {
        op: 'fake.state',
        sessionId: 'support',
        params: { chatId: 'c', state: 'typing' }
      })
    )

    expect(error.code).toBe('FORBIDDEN')
    expect(calls).toEqual([])
  })

  it('refuses a params.sessionId that names another session than the checked one', async () => {
    const error = await failure(
      dispatcher.dispatch(sessionKey('sales', 'send'), {
        op: 'fake.state',
        sessionId: 'sales',
        params: { sessionId: 'support', chatId: 'c', state: 'typing' }
      })
    )

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(calls).toEqual([])
  })

  it('needs the sessionId of the command when the route has one', async () => {
    const error = await failure(
      dispatcher.dispatch(adminPrincipal(null), {
        op: 'fake.state',
        params: { chatId: 'c', state: 'typing' }
      })
    )

    expect(error.code).toBe('VALIDATION_ERROR')
  })

  it('needs the scope of the operation, not only `events`', async () => {
    const error = await failure(
      dispatcher.dispatch(sessionKey('sales', 'events', 'read'), {
        op: 'fake.state',
        sessionId: 'sales',
        params: { chatId: 'c', state: 'typing' }
      })
    )

    expect(error.code).toBe('INSUFFICIENT_SCOPE')
    expect(calls).toEqual([])
  })

  it('lets only an admin key run an admin operation', async () => {
    const denied = await failure(
      dispatcher.dispatch(sessionKey('sales', 'send', 'read', 'manage'), {
        op: 'fake.reset',
        params: {}
      })
    )
    await dispatcher.dispatch(adminPrincipal(null), { op: 'fake.reset', params: {} })

    expect(denied.code).toBe('INSUFFICIENT_SCOPE')
    expect(calls.map(call => call.op)).toEqual(['reset'])
  })

  it('hands the principal of the socket to an operation that asks for it', async () => {
    const result = await dispatcher.dispatch(sessionKey('sales', 'webhooks'), {
      op: 'fake.whoAmI',
      params: {}
    })

    expect(result).toEqual({ sessionId: 'sales', admin: false })
  })

  it('passes the idempotency key as the Idempotency-Key header and ignores the HTTP reply', async () => {
    const result = await dispatcher.dispatch(sessionKey('sales', 'send'), {
      op: 'fake.echo',
      sessionId: 'sales',
      params: { text: 'hi' },
      idempotencyKey: 'once'
    })

    expect(result).toEqual({ sessionId: 'sales', key: 'once' })
    expect(calls[0]?.args).toEqual(['sales', { text: 'hi' }, 'once'])
  })

  it('refuses params the route has no place for', async () => {
    const error = await failure(
      dispatcher.dispatch(adminPrincipal(null), { op: 'fake.reset', params: { surprise: 1 } })
    )

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(calls).toEqual([])
  })

  it('treats a __proto__ key of the client as a key to refuse, never as a prototype', async () => {
    const params = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>

    const error = await failure(
      dispatcher.dispatch(adminPrincipal(null), { op: 'fake.reset', params })
    )

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('refuses a NUL in any part of the command, like the HTTP routes', async () => {
    for (const command of [
      { op: 'fake.echo', sessionId: 'sales', params: { text: 'a\u0000b' } },
      { op: 'fake.echo', sessionId: 'sales', params: { 'a\u0000': 1 } },
      { op: 'fake.echo', sessionId: 'sales', params: {}, idempotencyKey: 'k\u0000' }
    ]) {
      const error = await failure(dispatcher.dispatch(sessionKey('sales', 'send'), command))
      expect(error.code).toBe('VALIDATION_ERROR')
    }
    expect(calls).toEqual([])
  })

  it('does not know a command that no operation declares', async () => {
    const error = await failure(
      dispatcher.dispatch(adminPrincipal(null), { op: 'no.such', params: {} })
    )

    expect(error.code).toBe('NOT_FOUND')
  })

  it('fails the boot when a socket command has a parameter a socket cannot fill', async () => {
    await expect(build(BrokenController)).rejects.toThrow(/broken\.op: a request parameter/)
  })
})
