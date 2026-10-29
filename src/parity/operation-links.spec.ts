import { Controller, Get, Module, forwardRef, type Type } from '@nestjs/common'

import { WaOperation } from '../api/wa-operation.decorator.js'
import type { WaOperationMeta } from '../api/wa-operation.schema.js'

import { collectOperations } from './operation-links.js'

const operation = (id: string, wwebjs: string[] = []): WaOperationMeta => ({
  id,
  scope: 'read',
  summary: 'Summary',
  description: 'Description',
  errors: [],
  examples: { request: null, response: null },
  wwebjs,
  gateway: wwebjs.length === 0 ? true : undefined
})

const ids = async (root: Type): Promise<string[]> =>
  (await collectOperations(root)).map(found => found.id).sort()

describe('collectOperations', () => {
  it('reads the operations of the controllers of a module and of its imports', async () => {
    @Controller('a')
    class AController {
      @Get()
      @WaOperation(operation('a.read'))
      read(): void {}

      // No decorator: not a capability
      helper(): void {}
    }
    @Controller('b')
    class BController {
      @Get()
      @WaOperation(operation('b.read', ['Client.info']))
      read(): void {}
    }
    @Module({ controllers: [BController] })
    class BModule {}
    @Module({ imports: [BModule], controllers: [AController] })
    class AModule {}

    expect(await collectOperations(AModule)).toEqual([
      expect.objectContaining({ id: 'a.read' }),
      expect.objectContaining({ id: 'b.read', wwebjs: ['Client.info'] })
    ])
  })

  it('reads a module imported twice once', async () => {
    @Controller('shared')
    class SharedController {
      @Get()
      @WaOperation(operation('shared.read'))
      read(): void {}
    }
    @Module({ controllers: [SharedController] })
    class SharedModule {}
    @Module({ imports: [SharedModule] })
    class OneModule {}
    @Module({ imports: [SharedModule, OneModule] })
    class RootModule {}

    expect(await ids(RootModule)).toEqual(['shared.read'])
  })

  it('reads dynamic modules, promises of them and forwardRef imports', async () => {
    @Controller('dynamic')
    class DynamicController {
      @Get()
      @WaOperation(operation('dynamic.read'))
      read(): void {}
    }
    @Controller('forward')
    class ForwardController {
      @Get()
      @WaOperation(operation('forward.read'))
      read(): void {}
    }
    @Module({ controllers: [ForwardController] })
    class ForwardModule {}
    @Controller('late')
    class LateController {
      @Get()
      @WaOperation(operation('late.read'))
      read(): void {}
    }
    @Module({})
    class DynamicModule {}
    @Module({})
    class LateModule {}
    @Module({
      imports: [
        { module: DynamicModule, controllers: [DynamicController] },
        Promise.resolve({ module: LateModule, controllers: [LateController] }),
        forwardRef(() => ForwardModule)
      ]
    })
    class RootModule {}

    expect(await ids(RootModule)).toEqual(['dynamic.read', 'forward.read', 'late.read'])
  })

  it('reads the operations a controller inherits from its base class', async () => {
    class BaseController {
      @Get()
      @WaOperation(operation('base.read'))
      read(): void {}
    }
    @Controller('child')
    class ChildController extends BaseController {
      @Get('own')
      @WaOperation(operation('child.own'))
      own(): void {}
    }
    @Module({ controllers: [ChildController] })
    class RootModule {}

    expect(await ids(RootModule)).toEqual(['base.read', 'child.own'])
  })

  it('does not run getters', async () => {
    @Controller('getter')
    class GetterController {
      get boom(): never {
        throw new Error('getter ran')
      }
    }
    @Module({ controllers: [GetterController] })
    class RootModule {}

    expect(await collectOperations(RootModule)).toEqual([])
  })

  it('refuses an import it does not understand', async () => {
    @Module({ imports: ['not a module' as unknown as Type] })
    class RootModule {}

    await expect(collectOperations(RootModule)).rejects.toThrow(/import/)
  })

  it('refuses an operation that has neither a wwebjs link nor gateway: true', async () => {
    @Controller('bad')
    class BadController {
      @Get()
      @WaOperation({ ...operation('bad.read'), gateway: undefined })
      read(): void {}
    }
    @Module({ controllers: [BadController] })
    class RootModule {}

    await expect(collectOperations(RootModule)).rejects.toThrow(/wwebjs/)
  })
})
