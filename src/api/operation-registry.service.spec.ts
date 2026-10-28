import { Controller, Get, Post, type Type } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'

import { REQUIRED_SCOPE_KEY } from '../common/decorators/auth.decorators.js'

import { ApiModule } from './api.module.js'
import { OperationRegistryService } from './operation-registry.service.js'
import { WaOperation } from './wa-operation.decorator.js'
import type { WaOperationMeta } from './wa-operation.schema.js'

const VALID: WaOperationMeta = {
  id: 'chats.setState',
  scope: 'send',
  summary: 'Set typing state',
  description: 'Shows typing or recording in a chat.',
  socket: { command: 'chat.state' },
  errors: ['SESSION_NOT_READY'],
  examples: { request: { state: 'typing' }, response: { ok: true } },
  wwebjs: ['Chat.sendStateTyping']
}

function controllerWith(...operations: WaOperationMeta[]): Type {
  @Controller('fake')
  class FakeController {}
  operations.forEach((meta, index) => {
    const name = `op${index}`
    Object.defineProperty(FakeController.prototype, name, { value: () => ({}), writable: true })
    const descriptor = Object.getOwnPropertyDescriptor(FakeController.prototype, name)
    if (!descriptor) throw new Error('descriptor missing')
    WaOperation(meta)(FakeController.prototype, name, descriptor)
    Post(name)(FakeController.prototype, name, descriptor)
  })
  return FakeController
}

async function boot(...controllers: Type[]): Promise<OperationRegistryService> {
  const module = await Test.createTestingModule({ imports: [ApiModule], controllers }).compile()
  await module.init()
  return module.get(OperationRegistryService)
}

describe('OperationRegistryService', () => {
  it('lists the decorated methods with their metadata', async () => {
    const registry = await boot(
      controllerWith(VALID, {
        ...VALID,
        id: 'system.info',
        scope: 'admin',
        socket: undefined,
        wwebjs: [],
        gateway: true
      })
    )

    expect(registry.list().map(op => op.meta.id)).toEqual(['chats.setState', 'system.info'])
    expect(registry.get('chats.setState')?.methodName).toBe('op0')
    expect(registry.getByCommand('chat.state')?.meta.id).toBe('chats.setState')
    expect(registry.get('system.info')?.meta.gateway).toBe(true)
  })

  it('ignores methods without @WaOperation', async () => {
    @Controller('plain')
    class PlainController {
      @Get()
      ping(): string {
        return 'pong'
      }
    }

    const registry = await boot(PlainController)

    expect(registry.list()).toEqual([])
  })

  it('makes the guard enforce the declared scope', () => {
    const controller = controllerWith(VALID)
    const handler: unknown = Reflect.get(controller.prototype as object, 'op0')

    expect(new Reflector().get(REQUIRED_SCOPE_KEY, handler as () => unknown)).toBe('send')
  })

  describe('rejects incomplete metadata', () => {
    const incomplete: [string, Record<string, unknown>, string][] = [
      ['an empty summary', { summary: ' ' }, 'summary'],
      ['a missing description', { description: undefined }, 'description'],
      ['a missing response example', { examples: { request: {} } }, 'examples.response'],
      ['an unknown scope', { scope: 'owner' }, 'scope'],
      ['an unknown error code', { errors: ['NOPE'] }, 'errors.0'],
      ['an id without a dot', { id: 'setState' }, 'id'],
      ['no wwebjs link and no gateway flag', { wwebjs: [] }, 'wwebjs'],
      ['gateway with a wwebjs link', { gateway: true }, 'wwebjs'],
      ['a malformed wwebjs symbol', { wwebjs: ['sendMessage'] }, 'wwebjs.0'],
      ['a malformed socket command', { socket: { command: 'Chat State' } }, 'socket.command'],
      ['an unknown field', { visibility: 'public' }, '(operation)']
    ]

    it.each(incomplete)('%s', async (_label, patch, field) => {
      const meta = { ...VALID, ...patch }

      await expect(boot(controllerWith(meta))).rejects.toThrow(
        new RegExp(`Invalid @WaOperation metadata[\\s\\S]*op0: ${field.replace(/[.()]/g, '\\$&')}`)
      )
    })
  })

  it('rejects an operation without a route', async () => {
    @Controller('bare')
    class BareController {
      @WaOperation(VALID)
      op(): void {}
    }

    await expect(boot(BareController)).rejects.toThrow('BareController.op: has no route decorator')
  })

  it('reports every problem at once', async () => {
    const broken = [
      { ...VALID, summary: '' },
      { ...VALID, id: 'chats.other', socket: undefined, description: '' }
    ]

    await expect(boot(controllerWith(...broken))).rejects.toThrow(
      /op0: summary[\s\S]*op1: description/
    )
  })

  it('accepts a null request example for an operation without a body', async () => {
    const registry = await boot(
      controllerWith({ ...VALID, examples: { request: null, response: { ok: true } } })
    )

    expect(registry.list()).toHaveLength(1)
  })

  it('rejects a repeated id', async () => {
    const other = { ...VALID, socket: { command: 'chat.other' } }

    await expect(boot(controllerWith(VALID, other))).rejects.toThrow(
      'id "chats.setState" is already used'
    )
  })

  it('rejects a repeated socket command', async () => {
    const other = { ...VALID, id: 'chats.other' }

    await expect(boot(controllerWith(VALID, other))).rejects.toThrow(
      'socket command "chat.state" is already used'
    )
  })
})
