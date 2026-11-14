import 'reflect-metadata'

import { IS_PUBLIC_KEY, REQUIRED_SCOPE_KEY } from '../../common/decorators/auth.decorators.js'
import { ValidationError } from '../../common/errors.js'
import { collectOperations } from '../../parity/operation-links.js'
import type { InboundHookService } from '../../services/inbound-hook.service.js'
import type { MessageSendService, SendResult } from '../../services/message-send.service.js'
import { InboundSendBody } from '../../types/messages.dto.js'
import { WebhooksApiModule } from '../webhooks.module.js'

import { InboundController } from './inbound.controller.js'

const EXPECTED: Record<string, { scope: string; wwebjs: string[]; gateway: boolean }> = {
  'inboundHooks.create': { scope: 'webhooks', wwebjs: [], gateway: true },
  'inboundHooks.list': { scope: 'webhooks', wwebjs: [], gateway: true },
  'inboundHooks.revoke': { scope: 'webhooks', wwebjs: [], gateway: true },
  'inboundHooks.send': {
    scope: 'send',
    wwebjs: ['Client.sendMessage', 'Chat.sendMessage'],
    gateway: false
  }
}

describe('InboundController operations', () => {
  it('declares exactly the operations of the table, each with its scope', async () => {
    const operations = (await collectOperations(WebhooksApiModule)).filter(operation =>
      operation.id.startsWith('inboundHooks.')
    )

    expect(
      Object.fromEntries(
        operations.map(op => [
          op.id,
          { scope: op.scope, wwebjs: op.wwebjs, gateway: op.gateway === true }
        ])
      )
    ).toEqual(EXPECTED)
  })

  it('makes only the token route public to the API key guard, and no operation a socket command', async () => {
    const prototype: object = InboundController.prototype
    const handlers = Object.getOwnPropertyNames(prototype)
      .filter(name => name !== 'constructor')
      .map(
        name => [name, Object.getOwnPropertyDescriptor(prototype, name)?.value as object] as const
      )
    const publicMethods = handlers
      .filter(([, handler]) => Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true)
      .map(([name]) => name)
    expect(publicMethods).toEqual(['send'])
    expect(
      Object.fromEntries(
        handlers.map(([name, handler]) => [name, Reflect.getMetadata(REQUIRED_SCOPE_KEY, handler)])
      )
    ).toEqual({ create: 'webhooks', list: 'webhooks', revoke: 'webhooks', send: 'send' })

    const operations = (await collectOperations(WebhooksApiModule)).filter(operation =>
      operation.id.startsWith('inboundHooks.')
    )
    expect(operations.filter(operation => operation.socket !== undefined)).toEqual([])
  })
})

describe('InboundController', () => {
  const GRANT = { hookId: 'hook-1', sessionId: 'main' }
  const reply = { status: jest.fn(), header: jest.fn() }

  function setup(result: SendResult = { jobId: 'job-1', replayed: false }) {
    const hooks = {
      create: jest.fn(() => Promise.resolve({})),
      list: jest.fn(() => Promise.resolve([])),
      revoke: jest.fn(() => Promise.resolve({}))
    }
    const sender = {
      send: jest.fn((_request: { idempotencyKey?: string }) => Promise.resolve(result))
    }
    const controller = new InboundController(
      hooks as unknown as InboundHookService,
      sender as unknown as MessageSendService
    )
    return { controller, hooks, sender }
  }

  beforeEach(() => jest.clearAllMocks())

  it('sends through the session of the hook, never the one the caller names', async () => {
    const { controller, sender } = setup()
    const body = InboundSendBody.parse({ to: '+52 55 0000 0001', text: 'hola' })

    const answer = await controller.send(
      { token: 'ignored' },
      GRANT,
      { wait: true },
      'key-1',
      body,
      reply as never
    )

    expect(sender.send).toHaveBeenCalledWith(
      { sessionId: 'main', wait: true, idempotencyKey: 'inbound:hook-1:key-1' },
      { to: '+52 55 0000 0001', type: 'text', body: 'hola' }
    )
    expect(reply.status).toHaveBeenCalledWith(202)
    expect(answer).toEqual({ jobId: 'job-1', status: 'queued' })
  })

  it('keeps the idempotency keys of two hooks of a session apart', async () => {
    const { controller, sender } = setup()
    const body = InboundSendBody.parse({ to: '5215500000001', text: 'hola' })

    await controller.send({ token: 't' }, GRANT, { wait: true }, 'order-1', body, reply as never)
    await controller.send(
      { token: 't' },
      { hookId: 'hook-2', sessionId: 'main' },
      { wait: true },
      'order-1',
      body,
      reply as never
    )

    const keys = sender.send.mock.calls.map(([request]) => request.idempotencyKey)
    expect(keys).toEqual(['inbound:hook-1:order-1', 'inbound:hook-2:order-1'])
  })

  it('marks an answer replayed by the idempotency key', async () => {
    const { controller } = setup({ jobId: 'job-1', replayed: true })
    const body = InboundSendBody.parse({ to: '5215500000001', text: 'hola' })

    await controller.send({ token: 't' }, GRANT, { wait: false }, undefined, body, reply as never)

    expect(reply.header).toHaveBeenCalledWith('idempotent-replayed', 'true')
  })

  it('refuses an Idempotency-Key longer than 128 characters before sending anything', async () => {
    const { controller, sender } = setup()
    const body = InboundSendBody.parse({ to: '5215500000001', text: 'hola' })

    await expect(
      controller.send({ token: 't' }, GRANT, { wait: true }, 'k'.repeat(129), body, reply as never)
    ).rejects.toBeInstanceOf(ValidationError)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('manages the hooks of the session of the path', async () => {
    const { controller, hooks } = setup()

    await controller.create({ sessionId: 'main' }, { name: 'crisp' })
    await expect(controller.list({ sessionId: 'main' })).resolves.toEqual({ hooks: [] })
    await controller.revoke({ sessionId: 'main', hookId: 'hook-1' })

    expect(hooks.create).toHaveBeenCalledWith('main', 'crisp')
    expect(hooks.list).toHaveBeenCalledWith('main')
    expect(hooks.revoke).toHaveBeenCalledWith('main', 'hook-1')
  })
})

describe('InboundSendBody', () => {
  it('takes the body of messages.send as it is', () => {
    const body = { to: '5215500000001', type: 'text', body: 'hola' }
    expect(InboundSendBody.parse(body)).toEqual(body)
    expect(
      InboundSendBody.parse({ to: '5215500000001', type: 'location', latitude: 1, longitude: 2 })
    ).toMatchObject({ type: 'location' })
  })

  it('takes the short shape { to, text } as a text message', () => {
    expect(InboundSendBody.parse({ to: ' 5215500000001 ', text: 'hola' })).toEqual({
      to: '5215500000001',
      type: 'text',
      body: 'hola'
    })
  })

  it('reports a mistake against the shape the caller meant, field by field', () => {
    const full = InboundSendBody.safeParse({
      to: '5215500000001',
      type: 'media',
      source: { url: 'not a url' }
    })
    const short = InboundSendBody.safeParse({ to: '5215500000001', text: '' })

    expect(full.success).toBe(false)
    expect(short.success).toBe(false)
    const paths = (result: typeof full) =>
      result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))
    expect(paths(full)).toContain('source.url')
    expect(paths(short)).toEqual(['text'])
  })

  it.each([
    ['a body that is not an object', 'hola'],
    ['an array', [{ to: '5215500000001', text: 'hola' }]],
    ['an empty text', { to: '5215500000001', text: '' }],
    ['no recipient', { text: 'hola' }],
    ['both shapes mixed', { to: '5215500000001', text: 'hola', type: 'text', body: 'hola' }],
    ['an unknown field', { to: '5215500000001', text: 'hola', session: 'other' }],
    ['a session in the body', { to: '5215500000001', type: 'text', body: 'hola', sessionId: 'x' }],
    ['nothing', {}]
  ])('refuses %s', (_name, body) => {
    expect(InboundSendBody.safeParse(body).success).toBe(false)
  })
})
