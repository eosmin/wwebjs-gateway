import type { AddressInfo } from 'node:net'

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { type Socket, io } from 'socket.io-client'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { ApiModule } from '../api/api.module.js'
import { ChatsController } from '../api/controllers/chats.controller.js'
import { NotFoundError, UnauthorizedError } from '../common/errors.js'
import { type Principal, adminPrincipal, keyPrincipal } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import { parseEnv } from '../config/env.schema.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { AuthService } from '../services/auth.service.js'
import { ChatsService } from '../services/chats.service.js'
import type { EventEnvelope } from '../types/events.js'
import { EventBusService } from '../whatsapp/event-bus.service.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { EventReplayService, type ReplayPage } from './event-replay.service.js'
import { OperationDispatcherService } from './operation-dispatcher.service.js'
import { GatewayIoAdapter } from './socket-io.adapter.js'
import { SocketGateway } from './socket.gateway.js'

const KEYS: Record<string, Principal> = {
  admin: adminPrincipal('key-admin'),
  'sales-events': keyPrincipal('key-1', 'sales', ['events', 'send']),
  'sales-manage': keyPrincipal('key-2', 'sales', ['events', 'manage', 'send']),
  'sales-read': keyPrincipal('key-3', 'sales', ['read', 'send']),
  'sales-no-send': keyPrincipal('key-4', 'sales', ['events', 'read'])
}

function envelope(
  sessionId: string,
  seq: number,
  event: EventEnvelope['event'] = 'message',
  data: unknown = { id: `m${seq}` }
): EventEnvelope {
  return {
    id: `evt_${sessionId}_${seq}`,
    event,
    sessionId,
    seq,
    timestamp: '2026-11-14T10:00:00.000Z',
    data
  } as EventEnvelope
}

interface Ack {
  ok: boolean
  [key: string]: unknown
}

describe('SocketGateway', () => {
  let app: NestFastifyApplication
  let bus: EventBusService
  let gateway: SocketGateway
  let metrics: MetricsService
  let url: string
  let kept: EventEnvelope[]
  let lastSeq: number
  let revoked: Set<string>
  let authCalls: number
  let lastSeqFails: boolean
  const setState = jest.fn<Promise<void>, unknown[]>()
  const clients: Socket[] = []

  async function start(env: Record<string, string> = {}): Promise<void> {
    const authenticate = (rawKey: string | undefined): Promise<Principal> => {
      authCalls += 1
      const principal = rawKey === undefined ? undefined : KEYS[rawKey]
      if (principal === undefined || (rawKey !== undefined && revoked.has(rawKey))) {
        return Promise.reject(new UnauthorizedError('UNAUTHORIZED'))
      }
      return Promise.resolve(principal)
    }
    const config = parseEnv({ ...TEST_ENV, ...env })
    const module = await Test.createTestingModule({
      imports: [ApiModule],
      controllers: [ChatsController],
      providers: [
        EventBusService,
        MetricsService,
        SocketGateway,
        OperationDispatcherService,
        { provide: APP_CONFIG, useValue: config },
        { provide: AuthService, useValue: { authenticate } },
        { provide: ChatsService, useValue: { setState } },
        {
          provide: SessionManager,
          useValue: {
            status: (id: string): string => {
              if (id !== 'sales' && id !== 'support') {
                throw new NotFoundError('NOT_FOUND', `Session ${id} does not exist`)
              }
              return id === 'sales' ? 'qr' : 'ready'
            },
            qr: (id: string): string | undefined => (id === 'sales' ? 'QR-PAYLOAD' : undefined)
          }
        },
        {
          provide: EventReplayService,
          useValue: {
            read: (sessionId: string, afterSeq: number, limit: number): Promise<ReplayPage> => {
              const after = kept.filter(e => e.sessionId === sessionId && e.seq > afterSeq)
              return Promise.resolve({ events: after.slice(0, limit), more: after.length > limit })
            },
            lastSeq: (): Promise<number> =>
              lastSeqFails ? Promise.reject(new Error('redis down')) : Promise.resolve(lastSeq)
          }
        }
      ]
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useWebSocketAdapter(new GatewayIoAdapter(app, config))
    await app.init()
    await app.listen(0, '127.0.0.1')
    const { port } = app.getHttpServer().address() as AddressInfo
    url = `http://127.0.0.1:${port}`
    bus = app.get(EventBusService)
    gateway = app.get(SocketGateway)
    metrics = app.get(MetricsService)
  }

  function connect(apiKey: string | undefined, query?: Record<string, string>): Promise<Socket> {
    const socket = io(url, {
      auth: apiKey === undefined ? {} : { apiKey },
      ...(query && { query }),
      transports: ['websocket'],
      reconnection: false,
      forceNew: true
    })
    clients.push(socket)
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket))
      socket.once('connect_error', reject)
    })
  }

  async function rejection(apiKey: string | undefined, query?: Record<string, string>) {
    const error = (await connect(apiKey, query).then(
      () => undefined,
      (thrown: unknown) => thrown
    )) as (Error & { data?: { code: string } }) | undefined
    if (error === undefined) throw new Error('the handshake should have been refused')
    return error.data?.code
  }

  const ask = (socket: Socket, event: string, body: unknown): Promise<Ack> =>
    socket.timeout(3000).emitWithAck(event, body) as Promise<Ack>

  const errorCode = (ack: Ack): unknown => (ack['error'] as { code: string } | undefined)?.code

  function collect(socket: Socket): EventEnvelope[] {
    const received: EventEnvelope[] = []
    socket.on('wa:event', (event: EventEnvelope) => received.push(event))
    return received
  }

  // Events the server sent are in the client once a round trip after them has completed
  const settle = (socket: Socket): Promise<Ack> => ask(socket, 'unsubscribe', { sessionId: 'none' })

  beforeEach(() => {
    kept = []
    lastSeq = 0
    revoked = new Set()
    authCalls = 0
    lastSeqFails = false
    setState.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    for (const socket of clients.splice(0)) socket.close()
    await app.close()
  })

  describe('handshake', () => {
    beforeEach(() => start())

    it('refuses a connection with no key, with an unknown key and with a key in the query string', async () => {
      expect(await rejection(undefined)).toBe('UNAUTHORIZED')
      expect(await rejection('not-a-key')).toBe('UNAUTHORIZED')
      // A key in the URL ends up in logs: only `auth.apiKey` counts, even when it is a valid one
      expect(await rejection(undefined, { apiKey: 'admin' })).toBe('UNAUTHORIZED')
    })

    it('refuses a key without the events scope at the handshake', async () => {
      expect(await rejection('sales-read')).toBe('INSUFFICIENT_SCOPE')
    })

    it('accepts a key with the events scope and counts the connection', async () => {
      await connect('sales-events')

      expect(await metrics.scrape()).toMatch(/gw_socket_connections 1\b/)
    })
  })

  describe('handshake failures', () => {
    beforeEach(() => start({ RATE_LIMIT_MAX: '3' }))

    it('refuses an address that failed too often, before it looks at the key', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await rejection('guess')).toBe('UNAUTHORIZED')
      }

      expect(await rejection('admin')).toBe('RATE_LIMITED')
    })
  })

  describe('subscribe', () => {
    beforeEach(() => start())

    it('answers the snapshot: status, seq, and no qr for a key without manage', async () => {
      lastSeq = 41
      const socket = await connect('sales-events')

      const ack = await ask(socket, 'subscribe', { sessionId: 'sales' })

      expect(ack).toEqual({ ok: true, snapshot: { status: 'qr', seq: 41 } })
    })

    it('puts the qr in the snapshot only for a key with manage that named qr', async () => {
      const socket = await connect('sales-manage')

      const named = await ask(socket, 'subscribe', { sessionId: 'sales', events: ['qr'] })
      const unnamed = await ask(socket, 'subscribe', { sessionId: 'sales', events: ['message'] })

      expect(named).toEqual({ ok: true, snapshot: { status: 'qr', qr: 'QR-PAYLOAD', seq: 0 } })
      expect(unnamed).toEqual({ ok: true, snapshot: { status: 'qr', seq: 0 } })
    })

    it('keeps the subscription it had when a new one cannot read its snapshot', async () => {
      const socket = await connect('sales-events')
      await ask(socket, 'subscribe', { sessionId: 'sales', events: ['message_ack'] })
      const received = collect(socket)

      lastSeqFails = true
      const refused = await ask(socket, 'subscribe', { sessionId: 'sales', events: ['message'] })
      bus.publish(envelope('sales', 1, 'message'))
      bus.publish(envelope('sales', 2, 'message_ack'))
      await settle(socket)

      expect(refused.ok).toBe(false)
      expect(received.map(e => e.event)).toEqual(['message_ack'])
    })

    it('refuses a session the key cannot reach and one that does not exist', async () => {
      const socket = await connect('sales-events')

      expect(errorCode(await ask(socket, 'subscribe', { sessionId: 'support' }))).toBe('FORBIDDEN')
      const admin = await connect('admin')
      expect(errorCode(await ask(admin, 'subscribe', { sessionId: 'ghost' }))).toBe('NOT_FOUND')
    })

    it('lets only an admin key follow every session', async () => {
      const sales = await connect('sales-manage')
      const admin = await connect('admin')

      expect(errorCode(await ask(sales, 'subscribe', { sessionId: '*' }))).toBe('FORBIDDEN')
      expect(await ask(admin, 'subscribe', { sessionId: '*' })).toEqual({
        ok: true,
        snapshot: null
      })
    })

    it('answers VALIDATION_ERROR to a message that does not fit', async () => {
      const socket = await connect('admin')

      for (const body of [
        {},
        { sessionId: 'sales', extra: 1 },
        { sessionId: 'sales', events: ['nope'] }
      ]) {
        expect(errorCode(await ask(socket, 'subscribe', body))).toBe('VALIDATION_ERROR')
      }
    })
  })

  describe('fan-out', () => {
    beforeEach(() => start())

    it('sends a session only the events of the sessions it follows, in order', async () => {
      const socket = await connect('admin')
      await ask(socket, 'subscribe', { sessionId: 'sales' })
      const received = collect(socket)

      bus.publish(envelope('sales', 1))
      bus.publish(envelope('support', 1))
      bus.publish(envelope('sales', 2))
      await settle(socket)

      expect(received.map(e => `${e.sessionId}:${e.seq}`)).toEqual(['sales:1', 'sales:2'])
    })

    it('never sends the events of another session to a session key, whatever it asked', async () => {
      const socket = await connect('sales-events')
      await ask(socket, 'subscribe', { sessionId: 'sales' })
      await ask(socket, 'subscribe', { sessionId: 'support' })
      await ask(socket, 'subscribe', { sessionId: '*' })
      const received = collect(socket)

      bus.publish(envelope('support', 1))
      bus.publish(envelope('sales', 1))
      await settle(socket)

      expect(received.map(e => e.sessionId)).toEqual(['sales'])
    })

    it('filters by the events named in the subscription, and stops after unsubscribe', async () => {
      const socket = await connect('sales-events')
      await ask(socket, 'subscribe', { sessionId: 'sales', events: ['message_ack'] })
      const received = collect(socket)

      bus.publish(envelope('sales', 1, 'message'))
      bus.publish(envelope('sales', 2, 'message_ack'))
      await ask(socket, 'unsubscribe', { sessionId: 'sales' })
      bus.publish(envelope('sales', 3, 'message_ack'))
      await settle(socket)

      expect(received.map(e => e.seq)).toEqual([2])
    })

    it('sends every session to an admin that follows *', async () => {
      const socket = await connect('admin')
      await ask(socket, 'subscribe', { sessionId: '*' })
      const received = collect(socket)

      bus.publish(envelope('sales', 1))
      bus.publish(envelope('support', 1))
      await settle(socket)

      expect(received.map(e => e.sessionId)).toEqual(['sales', 'support'])
    })

    it('delivers an event once to a socket that follows its session and *', async () => {
      const socket = await connect('admin')
      await ask(socket, 'subscribe', { sessionId: '*' })
      await ask(socket, 'subscribe', { sessionId: 'sales' })
      const received = collect(socket)

      bus.publish(envelope('sales', 1))
      await settle(socket)

      expect(received).toHaveLength(1)
    })
  })

  describe('credential events (qr, code)', () => {
    beforeEach(() => start())

    it('refuses to subscribe by name to qr or code without the manage scope', async () => {
      const socket = await connect('sales-events')

      for (const event of ['qr', 'code']) {
        const ack = await ask(socket, 'subscribe', {
          sessionId: 'sales',
          events: ['message', event]
        })
        expect(errorCode(ack)).toBe('INSUFFICIENT_SCOPE')
      }
    })

    it('does not send qr or code to a key without manage, not even through * or no list', async () => {
      const socket = await connect('sales-events')
      await ask(socket, 'subscribe', { sessionId: 'sales' })
      await ask(socket, 'subscribe', { sessionId: 'support', events: ['*'] })
      const received = collect(socket)

      bus.publish(envelope('sales', 1, 'qr', { qr: 'QR-PAYLOAD' }))
      bus.publish(envelope('sales', 2, 'code', { code: 'ABCD-1234' }))
      bus.publish(envelope('sales', 3, 'message'))
      await settle(socket)

      expect(received.map(e => e.event)).toEqual(['message'])
    })

    it('sends qr and code to a key with manage only when it names them', async () => {
      const named = await connect('sales-manage')
      await ask(named, 'subscribe', { sessionId: 'sales', events: ['qr', 'code', 'message'] })
      const wildcard = await connect('sales-manage')
      await ask(wildcard, 'subscribe', { sessionId: 'sales', events: ['*'] })
      const none = await connect('sales-manage')
      await ask(none, 'subscribe', { sessionId: 'sales' })
      const [namedEvents, wildcardEvents, noneEvents] = [named, wildcard, none].map(collect)

      bus.publish(envelope('sales', 1, 'qr', { qr: 'QR-PAYLOAD' }))
      bus.publish(envelope('sales', 2, 'message'))
      await Promise.all([named, wildcard, none].map(settle))

      expect(namedEvents?.map(e => e.event)).toEqual(['qr', 'message'])
      expect(wildcardEvents?.map(e => e.event)).toEqual(['message'])
      expect(noneEvents?.map(e => e.event)).toEqual(['message'])
    })

    it('does not replay a credential event even when one is kept', async () => {
      kept = [envelope('sales', 1, 'qr', { qr: 'QR-PAYLOAD' }), envelope('sales', 2)]
      const socket = await connect('sales-manage')
      await ask(socket, 'subscribe', { sessionId: 'sales', events: ['message'] })
      const received = collect(socket)

      await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 0 })
      await settle(socket)

      expect(received.map(e => e.event)).toEqual(['message'])
    })
  })

  describe('command', () => {
    beforeEach(() => start())

    it('runs chat.state through the controller of the registry (typing round trip)', async () => {
      const socket = await connect('sales-events')

      const ack = await ask(socket, 'command', {
        op: 'chat.state',
        sessionId: 'sales',
        params: { chatId: '5215512345678@c.us', state: 'typing', durationMs: 5000 }
      })

      expect(ack).toEqual({ ok: true, data: null })
      expect(setState).toHaveBeenCalledWith('sales', '5215512345678@c.us', 'typing', 5000)
    })

    it('answers the errors of REST: validation, unknown command, session and scope', async () => {
      const sales = await connect('sales-events')
      const noSend = await connect('sales-no-send')
      const run = (socket: Socket, body: unknown): Promise<Ack> => ask(socket, 'command', body)
      const typing = { chatId: 'c', state: 'typing' }

      expect(
        errorCode(
          await run(sales, {
            op: 'chat.state',
            sessionId: 'sales',
            params: { chatId: 'c', state: 'x' }
          })
        )
      ).toBe('VALIDATION_ERROR')
      expect(errorCode(await run(sales, { op: 'no.such', params: {} }))).toBe('NOT_FOUND')
      expect(
        errorCode(await run(sales, { op: 'chat.state', sessionId: 'support', params: typing }))
      ).toBe('FORBIDDEN')
      expect(
        errorCode(await run(noSend, { op: 'chat.state', sessionId: 'sales', params: typing }))
      ).toBe('INSUFFICIENT_SCOPE')
      expect(setState).not.toHaveBeenCalled()
    })

    it('answers the error of the operation, with its code and no stack', async () => {
      setState.mockRejectedValue(new NotFoundError('CHAT_NOT_FOUND', 'No such chat'))
      const socket = await connect('sales-events')

      const ack = await ask(socket, 'command', {
        op: 'chat.state',
        sessionId: 'sales',
        params: { chatId: 'c', state: 'typing' }
      })

      expect(ack).toEqual({ ok: false, error: { code: 'CHAT_NOT_FOUND', message: 'No such chat' } })
    })

    it('limits the commands one socket may have running', async () => {
      const releases: (() => void)[] = []
      setState.mockImplementation(
        () =>
          new Promise<void>(resolve => {
            releases.push(resolve)
          })
      )
      const socket = await connect('sales-events')
      const body = {
        op: 'chat.state',
        sessionId: 'sales',
        params: { chatId: 'c', state: 'typing' }
      }
      const running = Array.from({ length: 32 }, () => ask(socket, 'command', body))
      await new Promise(resolve => setTimeout(resolve, 100))

      const refused = await ask(socket, 'command', body)
      for (const release of releases) release()
      const done = await Promise.all(running)

      expect(errorCode(refused)).toBe('RATE_LIMITED')
      expect(done.every(ack => ack.ok)).toBe(true)
    })
  })

  describe('command rate', () => {
    beforeEach(() => start({ RATE_LIMIT_MAX: '3' }))

    it('limits the commands of a key across all its sockets', async () => {
      const first = await connect('sales-events')
      const second = await connect('sales-events')
      const body = {
        op: 'chat.state',
        sessionId: 'sales',
        params: { chatId: 'c', state: 'typing' }
      }

      const answers = [
        await ask(first, 'command', body),
        await ask(second, 'command', body),
        await ask(first, 'command', body),
        await ask(second, 'command', body)
      ]

      expect(answers.map(ack => ack.ok)).toEqual([true, true, true, false])
      expect(errorCode(answers[3] as Ack)).toBe('RATE_LIMITED')
    })

    it('does not let a __proto__ key of the client change what the controller receives', async () => {
      const socket = await connect('sales-events')

      const ack = await ask(socket, 'command', {
        op: 'chat.state',
        sessionId: 'sales',
        params: JSON.parse(
          '{"chatId":"c","state":"typing","__proto__":{"state":"clear"}}'
        ) as Record<string, unknown>
      })

      // The key is dropped or refused, never applied: the state is the one the client wrote
      if (ack.ok) expect(setState).toHaveBeenCalledWith('sales', 'c', 'typing', undefined)
      else expect(errorCode(ack)).toBe('VALIDATION_ERROR')
      expect(setState).not.toHaveBeenCalledWith('sales', 'c', 'clear', undefined)
    })
  })

  describe('replay under a small queue', () => {
    beforeEach(async () => {
      await start({ SOCKET_MAX_QUEUED_EVENTS: '2' })
      kept = Array.from({ length: 20 }, (_, index) => envelope('sales', index + 1))
      lastSeq = 20
    })

    it('stops before the queue is full and says so, instead of disconnecting the client', async () => {
      const socket = await connect('sales-events')
      const received = collect(socket)

      const ack = await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 0 })
      await settle(socket)

      expect(ack.truncated).toBe(true)
      expect(socket.connected).toBe(true)
      expect(received.map(e => e.seq)).toEqual(
        Array.from({ length: received.length }, (_, index) => index + 1)
      )
      expect(ack['to']).toBe(received.length)
    })
  })

  describe('replay', () => {
    beforeEach(async () => {
      await start()
      kept = [1, 2, 3, 4, 5].map(seq => envelope('sales', seq))
      lastSeq = 5
    })

    it('re-emits what is kept after afterSeq, in order, and says what it covered', async () => {
      const socket = await connect('sales-events')
      const received = collect(socket)

      const ack = await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 2 })
      await settle(socket)

      expect(ack).toEqual({ ok: true, from: 3, to: 5, truncated: false })
      expect(received.map(e => e.seq)).toEqual([3, 4, 5])
    })

    it('says truncated when the limit cut the answer, so the client asks again from `to`', async () => {
      const socket = await connect('sales-events')
      const received = collect(socket)

      const ack = await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 0, limit: 2 })
      await settle(socket)

      expect(ack).toEqual({ ok: true, from: 1, to: 2, truncated: true })
      expect(received.map(e => e.seq)).toEqual([1, 2])
    })

    it('says truncated when the events right after afterSeq are gone', async () => {
      kept = kept.filter(e => e.seq > 3)
      const socket = await connect('sales-events')

      const ack = await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 0 })

      expect(ack).toEqual({ ok: true, from: 4, to: 5, truncated: true })
    })

    it('says truncated when an event is missing inside what was read', async () => {
      kept = kept.filter(e => e.seq !== 3)
      const socket = await connect('sales-events')

      const ack = await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 0 })

      expect(ack).toEqual({ ok: true, from: 1, to: 5, truncated: true })
    })

    it('says truncated when nothing is kept but the session went on, and not when it did not', async () => {
      const socket = await connect('sales-events')

      expect(await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 5 })).toEqual({
        ok: true,
        from: null,
        to: null,
        truncated: false
      })
      kept = []
      expect(await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 2 })).toEqual({
        ok: true,
        from: null,
        to: null,
        truncated: true
      })
    })

    it('applies the filter of the subscription to what it re-emits', async () => {
      kept = [envelope('sales', 1, 'message'), envelope('sales', 2, 'message_ack')]
      const socket = await connect('sales-events')
      await ask(socket, 'subscribe', { sessionId: 'sales', events: ['message_ack'] })
      const received = collect(socket)

      await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 0 })
      await settle(socket)

      expect(received.map(e => e.seq)).toEqual([2])
    })

    it('refuses a session the key cannot reach and a message that does not fit', async () => {
      const socket = await connect('sales-events')

      expect(errorCode(await ask(socket, 'replay', { sessionId: 'support', afterSeq: 0 }))).toBe(
        'FORBIDDEN'
      )
      expect(errorCode(await ask(socket, 'replay', { sessionId: 'sales', afterSeq: -1 }))).toBe(
        'VALIDATION_ERROR'
      )
      expect(
        errorCode(await ask(socket, 'replay', { sessionId: 'sales', afterSeq: 0, limit: 5000 }))
      ).toBe('VALIDATION_ERROR')
    })
  })

  describe('keys that stop being valid', () => {
    beforeEach(() => start())

    it('disconnects a socket whose key was revoked, and keeps the others', async () => {
      const revokedSocket = await connect('sales-events')
      const other = await connect('admin')
      await ask(revokedSocket, 'subscribe', { sessionId: 'sales' })
      const closed = new Promise<string>(resolve => revokedSocket.once('disconnect', resolve))

      revoked.add('sales-events')
      await gateway.revalidate()

      expect(await closed).toBe('io server disconnect')
      expect(other.connected).toBe(true)
      const scrape = await metrics.scrape()
      expect(scrape).toMatch(/gw_socket_disconnects_total\{reason="unauthorized"\} 1\b/)
      expect(scrape).toMatch(/gw_socket_connections 1\b/)
    })
  })

  describe('revalidation', () => {
    beforeEach(() => start())

    it('asks once per key and address, however many sockets share them', async () => {
      await connect('sales-events')
      await connect('sales-events')
      await connect('sales-events')
      const before = authCalls

      await gateway.revalidate()

      expect(authCalls - before).toBe(1)
    })
  })

  describe('slow consumer', () => {
    beforeEach(() => start({ SOCKET_MAX_QUEUED_EVENTS: '3' }))

    it('disconnects a client that does not read, counts it and stops holding its events', async () => {
      const slow = await connect('admin')
      await ask(slow, 'subscribe', { sessionId: 'sales' })
      const healthy = await connect('admin')
      await ask(healthy, 'subscribe', { sessionId: 'sales' })
      const received = collect(healthy)
      // The client stops reading from its TCP socket: the server cannot write, and its queue grows
      const { ws } = slow.io.engine.transport as unknown as {
        ws: { _socket: { pause(): void; resume(): void } }
      }
      const pausable = ws._socket
      pausable.pause()
      const closed = new Promise<string>(resolve => slow.once('disconnect', resolve))

      const filler = 'x'.repeat(200_000)
      for (let seq = 1; seq <= 200; seq += 1) {
        bus.publish(envelope('sales', seq, 'message', { id: `m${seq}`, filler }))
        // Lets the server write between events, as a real stream would
        await new Promise(resolve => setImmediate(resolve))
        if ((await metrics.scrape()).includes('slow_consumer"} 1')) break
      }

      expect(await metrics.scrape()).toMatch(
        /gw_socket_disconnects_total\{reason="slow_consumer"\} 1\b/
      )
      expect(received.length).toBeGreaterThan(0)
      // The healthy client kept receiving while the slow one was cut off
      expect(healthy.connected).toBe(true)
      pausable.resume()
      expect(await closed).toBe('io server disconnect')
      expect(await metrics.scrape()).toMatch(/gw_socket_connections 1\b/)
    }, 30_000)
  })
})
