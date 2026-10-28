import { Injectable, type OnModuleInit } from '@nestjs/common'
import { METHOD_METADATA } from '@nestjs/common/constants'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'

import { WA_OPERATION_KEY } from './wa-operation.decorator.js'
import { waOperationSchema, type WaOperationMeta } from './wa-operation.schema.js'

export interface RegisteredOperation {
  meta: WaOperationMeta
  // The controller instance and method, so the socket gateway calls the same handler as REST
  controller: object
  methodName: string
}

@Injectable()
export class OperationRegistryService implements OnModuleInit {
  private readonly operations = new Map<string, RegisteredOperation>()
  private readonly byCommand = new Map<string, RegisteredOperation>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector
  ) {}

  // Fails the boot, with every problem at once, when an operation is incomplete or repeated
  onModuleInit(): void {
    const problems: string[] = []

    for (const wrapper of this.discovery.getControllers()) {
      const instance: unknown = wrapper.instance
      if (typeof instance !== 'object' || instance === null) continue
      const prototype: unknown = Object.getPrototypeOf(instance)
      if (typeof prototype !== 'object' || prototype === null) continue

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler: unknown = Reflect.get(prototype, methodName)
        if (typeof handler !== 'function') continue
        const raw: unknown = this.reflector.get(WA_OPERATION_KEY, handler)
        if (raw === undefined) continue

        const where = `${instance.constructor.name}.${methodName}`
        // Without a route decorator it is no REST capability, yet docs and parity would count it
        if (this.reflector.get(METHOD_METADATA, handler) === undefined) {
          problems.push(`${where}: has no route decorator (@Get, @Post, ...)`)
          continue
        }
        const parsed = waOperationSchema.safeParse(raw)
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            problems.push(`${where}: ${issue.path.join('.') || '(operation)'} ${issue.message}`)
          }
          continue
        }
        const problem = this.add({ meta: parsed.data, controller: instance, methodName })
        if (problem) problems.push(`${where}: ${problem}`)
      }
    }

    if (problems.length > 0) {
      throw new Error(`Invalid @WaOperation metadata:\n- ${problems.join('\n- ')}`)
    }
  }

  list(): readonly RegisteredOperation[] {
    return [...this.operations.values()]
  }

  get(id: string): RegisteredOperation | undefined {
    return this.operations.get(id)
  }

  getByCommand(command: string): RegisteredOperation | undefined {
    return this.byCommand.get(command)
  }

  // Returns the reason the operation was refused, or undefined once it is registered
  private add(operation: RegisteredOperation): string | undefined {
    const { id, socket } = operation.meta
    if (this.operations.has(id)) return `id "${id}" is already used`
    if (socket && this.byCommand.has(socket.command)) {
      return `socket command "${socket.command}" is already used`
    }
    this.operations.set(id, operation)
    if (socket) this.byCommand.set(socket.command, operation)
    return undefined
  }
}
