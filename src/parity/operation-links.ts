import type { Type } from '@nestjs/common'

import { WA_OPERATION_KEY } from '../api/wa-operation.decorator.js'
import { waOperationSchema, type WaOperationMeta } from '../api/wa-operation.schema.js'

interface ModuleParts {
  module: Type
  controllers: unknown[]
  imports: unknown[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : [])

const isClass = (value: unknown): value is Type => typeof value === 'function'

// An import is a class, a dynamic module ({ module, controllers, imports }), a forwardRef or a
// promise of a dynamic module. Anything else is refused: skipping it would drop its operations from
// the parity count.
async function partsOf(reference: unknown): Promise<ModuleParts> {
  if (reference instanceof Promise) return partsOf(await (reference as Promise<unknown>))
  if (isClass(reference)) {
    const decorated = (key: string): unknown[] => listOf(Reflect.getMetadata(key, reference))
    return {
      module: reference,
      controllers: decorated('controllers'),
      imports: decorated('imports')
    }
  }
  if (isRecord(reference) && isClass(reference['module'])) {
    const own = await partsOf(reference['module'])
    return {
      module: own.module,
      controllers: [...own.controllers, ...listOf(reference['controllers'])],
      imports: [...own.imports, ...listOf(reference['imports'])]
    }
  }
  if (isRecord(reference) && typeof reference['forwardRef'] === 'function') {
    return partsOf((reference['forwardRef'] as () => unknown)())
  }
  throw new Error(
    `Cannot read the import ${String(reference)}: not a module class, dynamic module or forwardRef`
  )
}

// Own and inherited methods, a subclass method shadowing the base one. Getters are never run.
function* methodsOf(controller: Type): Generator<object> {
  const names = new Set<string>()
  for (
    let prototype: object | null = controller.prototype as object;
    prototype !== null && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor' || names.has(name)) continue
      names.add(name)
      const value: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value
      if (typeof value === 'function') yield value
    }
  }
}

// Every @WaOperation declared in the controllers of a module and of the modules it imports. It
// reads the decorator metadata, so no application has to boot. Nest registers the same operations
// at runtime through OperationRegistryService, which refuses what the schema refuses.
export async function collectOperations(root: Type): Promise<WaOperationMeta[]> {
  const seenModules = new Set<Type>()
  const seenControllers = new Set<unknown>()
  const operations: WaOperationMeta[] = []

  const walk = async (reference: unknown): Promise<void> => {
    const { module, controllers, imports } = await partsOf(reference)
    if (seenModules.has(module)) return
    seenModules.add(module)

    for (const controller of controllers.filter(isClass)) {
      if (seenControllers.has(controller)) continue
      seenControllers.add(controller)
      for (const handler of methodsOf(controller)) {
        const raw: unknown = Reflect.getMetadata(WA_OPERATION_KEY, handler)
        if (raw !== undefined) operations.push(waOperationSchema.parse(raw))
      }
    }
    for (const imported of imports) await walk(imported)
  }
  await walk(root)

  return operations
}
