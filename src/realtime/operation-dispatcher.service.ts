import {
  type ArgumentMetadata,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  type OnApplicationBootstrap,
  type PipeTransform,
  type Type
} from '@nestjs/common'
import { PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants'
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js'
import { Reflector } from '@nestjs/core'
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod'
import { from, lastValueFrom, switchMap } from 'rxjs'
import { z } from 'zod'

import {
  OperationRegistryService,
  type RegisteredOperation
} from '../api/operation-registry.service.js'
import { currentPrincipalFactory } from '../common/decorators/auth.decorators.js'
import { NotFoundError, ValidationError } from '../common/errors.js'
import { TimeoutInterceptor } from '../common/interceptors/timeout.interceptor.js'
import { hasNul } from '../common/lib/nul.js'
import { type Principal, assertScope, assertSessionAccess } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'

const IDEMPOTENCY_HEADER = 'idempotency-key'
const PATH_PARAM = /:([A-Za-z_]\w*)/g
const CUSTOM_ARGS_MARKER = '__customRouteArgs__'
const DESIGN_PARAMTYPES = 'design:paramtypes'

export interface SocketCommand {
  op: string
  sessionId?: string | undefined
  params: Readonly<Record<string, unknown>>
  idempotencyKey?: string | undefined
}

type ArgKind = 'param' | 'body' | 'query' | 'idempotencyKey' | 'response' | 'principal'

interface ArgPlan {
  index: number
  kind: ArgKind
  // `@Param('chatId')`: the one value, instead of the whole object
  data: string | undefined
  metatype: unknown
  pipes: readonly PipeTransform[]
}

interface CommandPlan {
  operation: RegisteredOperation
  handler: (...args: unknown[]) => unknown
  args: readonly ArgPlan[]
  // The `:name` segments of the route, which `params` fills
  pathParams: ReadonlySet<string>
  // Where the rest of `params` goes: the body of a write, the query of a read; `both` when the route
  // has the two (a send with `wait`), and then `queryKeys` says which names are the query's
  rest: 'body' | 'query' | 'both' | 'none'
  queryKeys: ReadonlySet<string>
}

interface RouteArgument {
  index: number
  data?: unknown
  pipes?: readonly unknown[]
  factory?: unknown
  schema?: unknown
}

// What a controller method gets for `@Res({ passthrough: true })`: the headers and the status are
// the HTTP answer, and a socket ack has neither. The body says everything the status would.
const discardingReply = {
  header: () => discardingReply,
  status: () => discardingReply
}

// Runs an operation of the registry for a socket command (TDD §6.7): the SAME controller method as
// REST, with the same scope check, `assertSessionAccess`, validation pipe, response schema and
// timeout. `params` is the flat union of what REST takes in the path, the query and the body: the
// names of the route (`:chatId`) are the path, and the rest is the body of a write or the query of a
// read. Nothing here is written per operation.
@Injectable()
export class OperationDispatcherService implements OnApplicationBootstrap {
  private readonly plans = new Map<string, CommandPlan>()
  private readonly validation = new ZodValidationPipe()
  private readonly serializer: NestInterceptor
  private readonly timeout: TimeoutInterceptor

  constructor(
    @Inject(OperationRegistryService) private readonly registry: OperationRegistryService,
    @Inject(Reflector) reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig
  ) {
    this.serializer = new ZodSerializerInterceptor(reflector)
    this.timeout = new TimeoutInterceptor(config)
  }

  // Every operation that declares a socket command is planned now, so one a socket could not run
  // (a parameter it cannot fill) fails the boot instead of the first client that calls it
  onApplicationBootstrap(): void {
    const problems: string[] = []
    for (const operation of this.registry.list()) {
      if (operation.meta.socket === undefined) continue
      try {
        this.plan(operation)
      } catch (error: unknown) {
        problems.push(`${operation.meta.id}: ${error instanceof Error ? error.message : 'invalid'}`)
      }
    }
    if (problems.length > 0) {
      throw new Error(`Socket commands that cannot be dispatched:\n- ${problems.join('\n- ')}`)
    }
  }

  // The `socket.command` names the registry knows
  commands(): readonly string[] {
    return this.registry.list().flatMap(({ meta }) => (meta.socket ? [meta.socket.command] : []))
  }

  async dispatch(principal: Principal, command: SocketCommand): Promise<unknown> {
    const operation = this.registry.getByCommand(command.op)
    if (operation === undefined) {
      throw new NotFoundError('NOT_FOUND', `There is no socket command "${command.op}"`)
    }
    // The scope of the operation is the one REST needs; `events` was checked by the gateway
    assertScope(principal, operation.meta.scope)
    if (hasNul(command.params) || hasNul(command.sessionId) || hasNul(command.idempotencyKey)) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        'The command contains a NUL (U+0000) character, which is not allowed'
      )
    }
    const plan = this.plan(operation)
    const sources = this.sources(plan, principal, command)
    const args: unknown[] = []
    for (const arg of plan.args) {
      args[arg.index] = await this.argument(arg, sources, principal, command.idempotencyKey)
    }

    const context = {
      getHandler: () => plan.handler,
      getClass: () => operation.controller.constructor
      // Only the two reads the interceptors make; anything else is a mistake that should throw
    } as unknown as ExecutionContext
    const run = (): Promise<unknown> =>
      Promise.resolve(Reflect.apply(plan.handler, operation.controller, args))
    const result: unknown = await lastValueFrom(
      this.timeout.intercept(context, {
        handle: () =>
          from(
            Promise.resolve(this.serializer.intercept(context, { handle: () => from(run()) }))
          ).pipe(switchMap(observable => observable))
      }),
      { defaultValue: undefined }
    )
    // A 204 has no body; the ack says so with null, as the empty JSON of REST does
    return result ?? null
  }

  // Path, body and query values of the command, and the checked session
  private sources(
    plan: CommandPlan,
    principal: Principal,
    command: SocketCommand
  ): Record<'param' | 'body' | 'query', Record<string, unknown>> {
    // `fromEntries` defines own properties: a `__proto__` key of the client stays a key to refuse, and
    // never sets the prototype of the object the controller receives
    const entries = Object.entries(command.params)
    const path: Record<string, unknown> = Object.fromEntries(
      entries.filter(([key]) => plan.pathParams.has(key))
    )
    const rest: Record<string, unknown> = Object.fromEntries(
      entries.filter(([key]) => !plan.pathParams.has(key))
    )
    if (plan.pathParams.has('sessionId')) {
      const { sessionId } = command
      if (sessionId === undefined) {
        throw new ValidationError('VALIDATION_ERROR', 'This command needs a sessionId', {
          field: 'sessionId'
        })
      }
      // The session the check ran on is the session the operation runs on: `params` cannot say another
      if (path.sessionId !== undefined && path.sessionId !== sessionId) {
        throw new ValidationError(
          'VALIDATION_ERROR',
          'params.sessionId differs from the sessionId of the command',
          { field: 'params.sessionId' }
        )
      }
      assertSessionAccess(principal, sessionId)
      path.sessionId = sessionId
    }
    if (plan.rest === 'none' && Object.keys(rest).length > 0) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        'The command takes no params besides the path',
        {
          unknown: Object.keys(rest)
        }
      )
    }
    if (plan.rest === 'both') {
      const query = Object.entries(rest).filter(([key]) => plan.queryKeys.has(key))
      const body = Object.entries(rest).filter(([key]) => !plan.queryKeys.has(key))
      return {
        param: path,
        body: Object.fromEntries(body),
        query: asQuery(Object.fromEntries(query))
      }
    }
    return {
      param: path,
      body: plan.rest === 'body' ? rest : {},
      query: plan.rest === 'query' ? asQuery(rest) : {}
    }
  }

  private async argument(
    arg: ArgPlan,
    sources: Record<'param' | 'body' | 'query', Record<string, unknown>>,
    principal: Principal,
    idempotencyKey: string | undefined
  ): Promise<unknown> {
    switch (arg.kind) {
      case 'principal':
        return principal
      case 'response':
        return discardingReply
      case 'idempotencyKey':
        // The `Idempotency-Key` header of REST; the operation checks its shape itself
        return idempotencyKey
      case 'param':
      case 'body':
      case 'query': {
        const whole = sources[arg.kind]
        const value = arg.data === undefined ? whole : whole[arg.data]
        return this.pipe(value, arg)
      }
    }
  }

  // Global validation first, then the pipes the parameter names (`@Body(new ZodValidationPipe(X))`)
  private async pipe(value: unknown, arg: ArgPlan): Promise<unknown> {
    const type =
      arg.kind === 'body' || arg.kind === 'query' || arg.kind === 'param' ? arg.kind : 'custom'
    const metadata: ArgumentMetadata = {
      type,
      metatype: arg.metatype as Type | undefined,
      data: arg.data
    }
    let current: unknown = await this.validation.transform(value, metadata)
    for (const pipe of arg.pipes) current = await pipe.transform(current, metadata)
    return current
  }

  private plan(operation: RegisteredOperation): CommandPlan {
    const cached = this.plans.get(operation.meta.id)
    if (cached) return cached
    const plan = buildPlan(operation)
    this.plans.set(operation.meta.id, plan)
    return plan
  }
}

// HTTP delivers every query value as a string, and the schemas of the queries read strings (`stringbool`
// does not take a boolean). A command carries JSON, so a number or a boolean becomes the string REST
// would have received; anything else is left as it is and fails the schema.
function asQuery(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
    ])
  )
}

function buildPlan(operation: RegisteredOperation): CommandPlan {
  const { controller, methodName } = operation
  const prototype: unknown = Object.getPrototypeOf(controller)
  const handlerRef: unknown = Reflect.get(controller, methodName)
  if (typeof handlerRef !== 'function' || typeof prototype !== 'object' || prototype === null) {
    throw new Error('the handler is not a method')
  }
  const handler = handlerRef as CommandPlan['handler']
  const paramtypes = Reflect.getMetadata(DESIGN_PARAMTYPES, prototype, methodName) as
    unknown[] | undefined
  const routeArguments = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller.constructor,
    methodName
  ) ?? {}) as Record<string, RouteArgument>

  const args: ArgPlan[] = []
  for (const [key, argument] of Object.entries(routeArguments)) {
    const kind = argKind(key, argument)
    if (argument.schema !== undefined) throw new Error('a parameter with a schema option')
    const pipes = (argument.pipes ?? []).map(toPipe)
    args.push({
      index: argument.index,
      kind: kind.kind,
      data: kind.data ?? (typeof argument.data === 'string' ? argument.data : undefined),
      metatype: paramtypes?.[argument.index],
      pipes
    })
  }
  args.sort((a, b) => a.index - b.index)
  const hasBody = args.some(arg => arg.kind === 'body')
  const hasQuery = args.some(arg => arg.kind === 'query')
  // With both, the names the query schema declares are the query's and every other one is the body's:
  // a body field named like a query parameter could never be reached, so the schema must be a plain
  // object whose names the dispatcher can read
  const queryKeys = hasBody && hasQuery ? queryKeysOf(args) : new Set<string>()

  const routePath = [
    Reflect.getMetadata(PATH_METADATA, controller.constructor),
    Reflect.getMetadata(PATH_METADATA, handler)
  ]
    .flatMap((part: unknown) => (typeof part === 'string' ? [part] : []))
    .join('/')
  return {
    operation,
    handler,
    args,
    pathParams: new Set([...routePath.matchAll(PATH_PARAM)].map(match => match[1] ?? '')),
    queryKeys,
    rest: hasBody && hasQuery ? 'both' : hasBody ? 'body' : hasQuery ? 'query' : 'none'
  }
}

function queryKeysOf(args: readonly ArgPlan[]): ReadonlySet<string> {
  const query = args.find(arg => arg.kind === 'query')
  const schema: unknown = (query?.metatype as { schema?: unknown } | undefined)?.schema
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('a route with a body and a query whose query is not a Zod object DTO')
  }
  const keys = new Set(Object.keys(schema.shape))
  // A name in both could only reach the query, so the body would lose a field with no error
  const body = args.find(arg => arg.kind === 'body')
  const clash = [
    ...fieldNames((body?.metatype as { schema?: unknown } | undefined)?.schema)
  ].filter(name => keys.has(name))
  if (clash.length > 0) {
    throw new Error(`the body and the query both declare "${clash.join('", "')}"`)
  }
  return keys
}

// The field names of an object schema, or of every branch of a union of them
function fieldNames(schema: unknown): Set<string> {
  if (schema instanceof z.ZodObject) return new Set(Object.keys(schema.shape))
  if (schema instanceof z.ZodUnion) {
    return new Set((schema.options as unknown[]).flatMap(option => [...fieldNames(option)]))
  }
  return new Set()
}

const KIND_BY_PARAMTYPE: ReadonlyMap<number, ArgKind> = new Map<number, ArgKind>([
  [Number(RouteParamtypes.BODY), 'body'],
  [Number(RouteParamtypes.QUERY), 'query'],
  [Number(RouteParamtypes.PARAM), 'param'],
  [Number(RouteParamtypes.RESPONSE), 'response']
])

function argKind(key: string, argument: RouteArgument): { kind: ArgKind; data?: string } {
  if (key.includes(CUSTOM_ARGS_MARKER)) {
    if (argument.factory === currentPrincipalFactory) return { kind: 'principal' }
    throw new Error('a custom parameter decorator other than CurrentPrincipal')
  }
  // The key is `<paramtype>:<index>`; the number is Nest's own RouteParamtypes
  const paramtype = Number(key.split(':')[0])
  if (paramtype === Number(RouteParamtypes.HEADERS)) {
    if (argument.data === IDEMPOTENCY_HEADER) return { kind: 'idempotencyKey' }
    throw new Error(`the header "${String(argument.data)}", only ${IDEMPOTENCY_HEADER} is taken`)
  }
  const kind = KIND_BY_PARAMTYPE.get(paramtype)
  if (kind === undefined) throw new Error(`a request parameter of type ${paramtype}`)
  return { kind }
}

function toPipe(pipe: unknown): PipeTransform {
  if (typeof pipe === 'function') return new (pipe as new () => PipeTransform)()
  if (typeof pipe === 'object' && pipe !== null && 'transform' in pipe) {
    return pipe as PipeTransform
  }
  throw new Error('a parameter pipe that is neither a class nor an instance')
}
