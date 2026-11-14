import { Inject, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { normalizeIp } from '@nestjs/throttler'
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage as OnMessage,
  WebSocketGateway
} from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'
import type { ZodType } from 'zod'

import { Public } from '../common/decorators/auth.decorators.js'
import {
  AppError,
  ErrorCode,
  ForbiddenError,
  UnauthorizedError,
  ValidationError
} from '../common/errors.js'
import { describeException } from '../common/filters/all-exceptions.filter.js'
import { resolveClientIp } from '../common/lib/client-ip.js'
import { type Principal, assertScope, assertSessionAccess } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { AuthService } from '../services/auth.service.js'
import { assertCredentialEventsAllowed, receivesEvent } from '../services/webhook.service.js'
import { CREDENTIAL_EVENTS, type EventEnvelope } from '../types/events.js'
import { ALL_EVENTS, EventBusService } from '../whatsapp/event-bus.service.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { EventReplayService } from './event-replay.service.js'
import { CommandLimiter, HandshakeLimiter } from './handshake-limiter.js'
import { OperationDispatcherService } from './operation-dispatcher.service.js'
import {
  ALL_SESSIONS,
  CommandMessage,
  type CommandAck,
  MAX_COMMANDS_IN_FLIGHT,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  ReplayMessage,
  type ReplayAck,
  SOCKET_EVENT,
  SubscribeMessage,
  type SocketFailure,
  type SubscribeAck,
  type SubscribeSnapshot,
  UnsubscribeMessage,
  type UnsubscribeAck
} from './socket.protocol.js'

// Keys are checked again this often, so a key revoked, rotated out or expired does not keep a socket
// open for as long as the socket lives
const REVALIDATE_INTERVAL_MS = 30_000
const ENVIRONMENT_KEY = 'environment'

interface Subscription {
  sessionId: string
  // null: every event but the credential ones
  events: ReadonlySet<string> | null
}

// What the handshake learned, until the connection is registered
interface Handshake {
  principal: Principal
  apiKey: string
  address: string
}

interface ClientState extends Handshake {
  socket: Socket
  subscriptions: Map<string, Subscription>
  commandsInFlight: number
  closed: boolean
}

// Socket.IO for the realtime stream and the bidirectional commands (TDD §6.10)
//
// - Handshake: `auth.apiKey` is checked with AuthService like the key of a REST call; a key without
//   the `events` scope is refused here. Never the query string: it ends up in logs.
// - Isolation: a subscription is checked with `assertSessionAccess` and the fan-out checks it again
//   per event, so a socket never receives the event of a session its key cannot reach.
// - Credentials: `qr` and `code` need the `manage` scope AND to be named; `*` and the snapshot of a
//   key without `manage` never carry them (the same rule as the webhooks).
// - Commands: the operations of the registry that declare a socket command, run by the dispatcher
//   with the scope and the session checks of REST.
// - Backpressure: a client whose queue of unsent packets reaches SOCKET_MAX_QUEUED_EVENTS is
//   disconnected (`slow_consumer`); the gateway never holds the backlog of a client that does not read.
//
// - Global guards: the rate limit guard skips the websocket context (it reads HTTP headers); the limits of
//   a socket are the handshake limiter and the command limiter (`subscribe`, `unsubscribe` and `replay`
//   have none yet, see the plan). `@Public()` makes ApiKeyGuard pass.
//
// Single instance by design: no Redis adapter, rooms are not used, the fan-out is a map in memory.
@Public()
@WebSocketGateway()
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SocketGateway.name)
  private readonly handshakes = new WeakMap<Socket, Handshake>()
  private readonly clients = new Map<Socket, ClientState>()
  // Who follows what: a session id, or `*`
  private readonly followers = new Map<string, Set<ClientState>>()
  private readonly limiter: HandshakeLimiter
  private readonly commandLimiter: CommandLimiter
  private revalidating = false
  private stopBus: (() => void) | undefined
  private revalidateTimer: NodeJS.Timeout | undefined

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(EventBusService) private readonly bus: EventBusService,
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(EventReplayService) private readonly replay: EventReplayService,
    @Inject(OperationDispatcherService) private readonly dispatcher: OperationDispatcherService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {
    this.limiter = new HandshakeLimiter(config.RATE_LIMIT_MAX)
    this.commandLimiter = new CommandLimiter(config.RATE_LIMIT_MAX)
  }

  onModuleInit(): void {
    this.stopBus = this.bus.subscribe(ALL_EVENTS, envelope => this.fanOut(envelope))
    this.revalidateTimer = setInterval(() => void this.revalidate(), REVALIDATE_INTERVAL_MS)
    this.revalidateTimer.unref()
  }

  onModuleDestroy(): void {
    this.stopBus?.()
    this.stopBus = undefined
    if (this.revalidateTimer !== undefined) clearInterval(this.revalidateTimer)
    this.revalidateTimer = undefined
  }

  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
        (error: unknown) => next(toHandshakeError(error))
      )
    })
  }

  handleConnection(socket: Socket): void {
    const handshake = this.handshakes.get(socket)
    if (handshake === undefined) {
      // The middleware always sets it; a socket that got here without is refused
      socket.disconnect(true)
      return
    }
    this.handshakes.delete(socket)
    this.clients.set(socket, {
      ...handshake,
      socket,
      subscriptions: new Map(),
      commandsInFlight: 0,
      closed: false
    })
    this.metrics.metrics.socketConnections.inc()
  }

  handleDisconnect(socket: Socket): void {
    const state = this.clients.get(socket)
    if (state === undefined) return
    this.forget(state)
    this.metrics.metrics.socketConnections.dec()
  }

  @OnMessage('subscribe')
  async onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown
  ): Promise<SubscribeAck> {
    return this.answer(async () => {
      const state = this.requireState(socket)
      const message = parse(SubscribeMessage, body)
      assertScope(state.principal, 'events')
      const { sessionId } = message
      if (sessionId === ALL_SESSIONS) {
        if (!state.principal.isAdmin) {
          throw new ForbiddenError('FORBIDDEN', 'Only an admin key may follow every session')
        }
      } else {
        assertSessionAccess(state.principal, sessionId)
        // Throws NOT_FOUND for a session that does not exist
        this.sessions.status(sessionId)
      }
      // Naming `qr` or `code` is the `manage` scope; a wildcard or no list never carries them
      assertCredentialEventsAllowed(state.principal, message.events)
      if (
        !state.subscriptions.has(sessionId) &&
        state.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET
      ) {
        throw new ForbiddenError(
          'FORBIDDEN',
          `A socket may follow at most ${MAX_SUBSCRIPTIONS_PER_SOCKET} sessions`
        )
      }
      // Registered before the snapshot is read: an event that lands in between reaches the client, and
      // the `seq` of the snapshot lets it drop the ones the snapshot already covers
      const previous = state.subscriptions.get(sessionId)
      const subscription: Subscription = {
        sessionId,
        events:
          message.events === undefined || message.events.includes('*')
            ? explicitCredentialEvents(message.events)
            : new Set(message.events)
      }
      this.follow(state, subscription)
      try {
        return {
          ok: true as const,
          snapshot:
            sessionId === ALL_SESSIONS ? null : await this.snapshot(state, sessionId, subscription)
        }
      } catch (error: unknown) {
        // A refused change leaves the socket as it was: the subscription it had stays
        if (previous === undefined) this.unfollow(state, sessionId)
        else this.follow(state, previous)
        throw error
      }
    })
  }

  @OnMessage('unsubscribe')
  onUnsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown
  ): Promise<UnsubscribeAck> {
    return this.answer(() => {
      const state = this.requireState(socket)
      const { sessionId } = parse(UnsubscribeMessage, body)
      this.unfollow(state, sessionId)
      return Promise.resolve({ ok: true as const })
    })
  }

  @OnMessage('command')
  async onCommand(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown
  ): Promise<CommandAck> {
    return this.answer(async () => {
      const state = this.requireState(socket)
      const message = parse(CommandMessage, body)
      assertScope(state.principal, 'events')
      // Per key, not per socket: many sockets of one key share the allowance of a REST key
      if (!this.commandLimiter.tryAcquire(state.principal.keyId ?? ENVIRONMENT_KEY)) {
        throw new AppError(
          ErrorCode.RATE_LIMITED,
          'Too many commands from this key; retry after a minute'
        )
      }
      if (state.commandsInFlight >= MAX_COMMANDS_IN_FLIGHT) {
        throw new AppError(
          ErrorCode.RATE_LIMITED,
          `A socket may have at most ${MAX_COMMANDS_IN_FLIGHT} commands running; wait for their answers`
        )
      }
      state.commandsInFlight += 1
      try {
        const data = await this.dispatcher.dispatch(state.principal, {
          op: message.op,
          sessionId: message.sessionId,
          params: message.params,
          idempotencyKey: message.idempotencyKey
        })
        return { ok: true as const, data }
      } finally {
        state.commandsInFlight -= 1
      }
    })
  }

  @OnMessage('replay')
  async onReplay(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown
  ): Promise<ReplayAck> {
    return this.answer(async () => {
      const state = this.requireState(socket)
      const { sessionId, afterSeq, limit } = parse(ReplayMessage, body)
      assertScope(state.principal, 'events')
      assertSessionAccess(state.principal, sessionId)
      const page = await this.replay.read(sessionId, afterSeq, limit)
      // What the socket asked to follow decides what it gets back; with no subscription, everything but
      // the credential events (which are never kept anyway)
      const filter = state.subscriptions.get(sessionId) ?? state.subscriptions.get(ALL_SESSIONS)
      let processed = 0
      let stopped = false
      for (const envelope of page.events) {
        // A page is written in one go: stop before the queue the client may hold is full, rather than
        // cut it off as a slow consumer in the middle of the replay it asked for
        if (queuedPackets(state.socket) >= this.config.SOCKET_MAX_QUEUED_EVENTS) {
          stopped = true
          break
        }
        if (this.wants(state, filter, envelope) && !this.emit(state, envelope)) {
          stopped = true
          break
        }
        processed += 1
      }
      const covered = page.events.slice(0, processed)
      const first = covered[0]
      const last = covered[covered.length - 1]
      // The answer may be missing something when more is kept or the page stopped early, when an event
      // is missing from the start or the inside of what was read (it expired, failed to be kept, or is a
      // credential event, which is never kept), or when nothing is kept although the session went on.
      // The end is not checked: what came after the page reaches the client live.
      const truncated =
        page.more ||
        stopped ||
        hasGap(afterSeq, covered) ||
        (page.events.length === 0 && (await this.replay.lastSeq(sessionId)) > afterSeq)
      return {
        ok: true as const,
        from: first?.seq ?? null,
        to: last?.seq ?? null,
        truncated
      }
    })
  }

  // The bus calls this for every event of every session
  fanOut(envelope: EventEnvelope): void {
    const targets = new Set<ClientState>([
      ...(this.followers.get(envelope.sessionId) ?? []),
      ...(this.followers.get(ALL_SESSIONS) ?? [])
    ])
    for (const state of targets) {
      if (state.closed) continue
      const delivered = [...state.subscriptions.values()].some(
        subscription =>
          (subscription.sessionId === ALL_SESSIONS ||
            subscription.sessionId === envelope.sessionId) &&
          this.wants(state, subscription, envelope)
      )
      if (delivered) this.emit(state, envelope)
    }
  }

  // Whether this socket may have this event, decided again for every event
  private wants(
    state: ClientState,
    subscription: Subscription | undefined,
    envelope: EventEnvelope
  ): boolean {
    const { principal } = state
    if (!principal.scopes.has('events')) return false
    if (principal.sessionId !== null && principal.sessionId !== envelope.sessionId) return false
    if (CREDENTIAL_EVENTS.includes(envelope.event)) {
      // Named by the subscription, and the key still has `manage`
      return principal.scopes.has('manage') && subscription?.events?.has(envelope.event) === true
    }
    if (subscription === undefined) return true
    return (
      subscription.events === null ||
      receivesEvent({ events: [...subscription.events] }, envelope.event)
    )
  }

  // False when the client was disconnected for being too slow
  private emit(state: ClientState, envelope: EventEnvelope): boolean {
    if (state.closed) return false
    // The packets engine.io holds for a transport that is not writable: what grows when a client does
    // not read. Checked before the emit, so the queue never passes the limit by more than one.
    if (queuedPackets(state.socket) >= this.config.SOCKET_MAX_QUEUED_EVENTS) {
      this.drop(state, 'slow_consumer')
      return false
    }
    state.socket.emit(SOCKET_EVENT, envelope)
    return true
  }

  private async snapshot(
    state: ClientState,
    sessionId: string,
    subscription: Subscription
  ): Promise<SubscribeSnapshot> {
    const status = this.sessions.status(sessionId)
    // The QR links a device to the account: only a key with `manage` that named `qr` sees it, the
    // same rule as the event
    const qr =
      state.principal.scopes.has('manage') && subscription.events?.has('qr') === true
        ? this.sessions.qr(sessionId)
        : undefined
    return {
      status,
      ...(qr !== undefined && { qr }),
      seq: await this.replay.lastSeq(sessionId)
    }
  }

  private follow(state: ClientState, subscription: Subscription): void {
    if (state.closed) return
    state.subscriptions.set(subscription.sessionId, subscription)
    const set = this.followers.get(subscription.sessionId) ?? new Set<ClientState>()
    set.add(state)
    this.followers.set(subscription.sessionId, set)
  }

  private unfollow(state: ClientState, sessionId: string): void {
    state.subscriptions.delete(sessionId)
    const set = this.followers.get(sessionId)
    set?.delete(state)
    if (set?.size === 0) this.followers.delete(sessionId)
  }

  private forget(state: ClientState): void {
    state.closed = true
    for (const sessionId of [...state.subscriptions.keys()]) this.unfollow(state, sessionId)
    this.clients.delete(state.socket)
  }

  private drop(state: ClientState, reason: 'slow_consumer' | 'unauthorized'): void {
    if (state.closed) return
    this.metrics.metrics.socketDisconnects.inc({ reason })
    this.logger.warn(
      `Disconnecting a socket (${reason}), key ${state.principal.keyId ?? 'environment'}, ${state.subscriptions.size} subscriptions`
    )
    // `forget` first: nothing is emitted to it any more, and `handleDisconnect` finds it gone
    this.forget(state)
    this.metrics.metrics.socketConnections.dec()
    state.socket.disconnect(true)
  }

  // A key that was revoked, expired or lost its address list ends its sockets; a database that is
  // down does not (the answer is unknown, and a missed event is worse than a late disconnect)
  async revalidate(): Promise<void> {
    // A slow database must not pile up ticks
    if (this.revalidating) return
    this.revalidating = true
    try {
      // One lookup per key and address, however many sockets share them
      const groups = new Map<string, ClientState[]>()
      for (const state of this.clients.values()) {
        const group = `${state.address}\u0000${state.apiKey}`
        groups.set(group, [...(groups.get(group) ?? []), state])
      }
      await Promise.all(
        [...groups.values()].map(async members => {
          const [first] = members
          if (first === undefined) return
          try {
            const principal = await this.auth.authenticate(first.apiKey, first.address)
            for (const state of members) {
              if (principal.scopes.has('events')) state.principal = principal
              else this.drop(state, 'unauthorized')
            }
          } catch (error: unknown) {
            if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
              for (const state of members) this.drop(state, 'unauthorized')
            }
          }
        })
      )
    } finally {
      this.revalidating = false
    }
  }

  private async authenticate(socket: Socket): Promise<void> {
    // The address as it is, for the allowlist of the key (a masked one would match the wrong range); the
    // normalized one only keys the failure counter, so rotating the low bits of an IPv6 address buys nothing
    const address = resolveClientIp(
      socket.handshake.address,
      headerValue(socket.handshake.headers['x-forwarded-for']),
      this.config.TRUST_PROXY_HOPS
    )
    const bucket = normalizeIp(address)
    if (this.limiter.isBlocked(bucket)) {
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        'Too many failed handshakes from this address; try again in a minute'
      )
    }
    const { apiKey } = (socket.handshake.auth ?? {}) as { apiKey?: unknown }
    try {
      const key = typeof apiKey === 'string' ? apiKey : undefined
      const principal = await this.auth.authenticate(key, address)
      assertScope(principal, 'events')
      // `key` is a string here: authenticate refused anything else
      this.handshakes.set(socket, { principal, apiKey: key ?? '', address })
    } catch (error: unknown) {
      this.limiter.recordFailure(bucket)
      throw error
    }
  }

  private requireState(socket: Socket): ClientState {
    const state = this.clients.get(socket)
    if (state === undefined || state.closed) {
      throw new UnauthorizedError('UNAUTHORIZED')
    }
    return state
  }

  // Every handler ends in an ack, never in a thrown error: an exception would reach Nest's exception
  // layer, which is written for HTTP
  private async answer<T extends object>(run: () => Promise<T>): Promise<T | SocketFailure> {
    try {
      return await run()
    } catch (error: unknown) {
      return this.failure(error)
    }
  }

  private failure(error: unknown): SocketFailure {
    const { status, ...body } = describeException(error, this.config.NODE_ENV === 'production')
    if (status >= 500) this.logger.error(error)
    return {
      ok: false,
      error: {
        code: body.code,
        message: body.message,
        ...(body.details !== undefined && { details: body.details })
      }
    }
  }
}

// `qr` and `code` can be named in the list but not through `*`; an absent list names none
function explicitCredentialEvents(
  events: readonly string[] | undefined
): ReadonlySet<string> | null {
  const named = (events ?? []).filter(event => CREDENTIAL_EVENTS.includes(event))
  return named.length === 0 ? null : new Set(['*', ...named])
}

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  throw new ValidationError('VALIDATION_ERROR', 'The message does not match the expected shape', {
    issues: parsed.error.issues.map(issue => ({
      path: issue.path.join('.'),
      code: issue.code
    }))
  })
}

// engine.io keeps the packets of a transport that is not writable in `writeBuffer`, which its typings
// mark private: the one number that says how far behind a client is. A spec drives a client that does
// not read, so a version that renames it fails there.
function queuedPackets(socket: Socket): number {
  const { writeBuffer } = socket.conn as unknown as { writeBuffer?: readonly unknown[] }
  return writeBuffer?.length ?? 0
}

// Whether an event is missing before the first of `events` or between two of them
function hasGap(afterSeq: number, events: readonly EventEnvelope[]): boolean {
  let previous = afterSeq
  for (const { seq } of events) {
    if (seq !== previous + 1) return true
    previous = seq
  }
  return false
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

// What socket.io hands a client as `connect_error`: a message and the `data` we attach
function toHandshakeError(error: unknown): Error & { data: SocketFailure['error'] } {
  const { code, message, details } = describeException(error, true)
  return Object.assign(new Error(code), {
    data: { code, message, ...(details !== undefined && { details }) }
  })
}
