import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { Logger } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { type Socket, io } from 'socket.io-client'

import type { AppConfig } from '../../src/config/env.schema.js'
import type { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'

import { REAL_ENV, TEST_ENV, resetEnv, setEnv } from './env.js'
import { FakeWhatsAppClientFactory, type FakeWhatsAppClient } from './fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

export interface Ack {
  ok: boolean
  error?: { code: string }
  [key: string]: unknown
}

export interface Handshake {
  socket?: Socket
  error?: { data?: { code?: string } }
}

// The whole application (every global guard, pipe, interceptor and filter of AppModule) listening on a
// loopback port, with the fake WhatsApp client, real Postgres and Redis, and a real socket.io-client.
// A spec that hand-builds a module never mounts the global components, which is how a global guard
// that assumes an HTTP request went unseen: it broke every socket message of the real application.
export class SocketApp {
  readonly id = `sock-${randomUUID().slice(0, 8)}`
  readonly other = `${this.id}-other`
  private readonly factory = new FakeWhatsAppClientFactory()
  private readonly sockets: Socket[] = []
  private app: NestFastifyApplication | undefined
  private sessions: SessionsRepository | undefined
  private redis: RedisService | undefined
  private url = ''
  private loggedErrors:
    jest.SpyInstance<void, [message: unknown, ...optionalParams: unknown[]]> | undefined

  async boot(env: Record<string, string>): Promise<void> {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    setEnv({ DATABASE_URL, REDIS_URL, ...env })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { GatewayIoAdapter } = await import('../../src/realtime/socket-io.adapter.js')
    const { APP_CONFIG } = await import('../../src/config/config.module.js')
    const { SessionsRepository } =
      await import('../../src/database/repositories/sessions.repository.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(this.factory.create)
      .compile()
    const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    // As main.ts does
    app.useWebSocketAdapter(new GatewayIoAdapter(app, app.get<AppConfig>(APP_CONFIG)))
    await app.init()
    await app.listen(0, '127.0.0.1')
    const { port } = app.getHttpServer().address() as AddressInfo
    this.url = `http://127.0.0.1:${port}`
    this.app = app
    this.sessions = app.get(SessionsRepository)
    this.redis = app.get(RedisService)
  }

  async shutdown(): Promise<void> {
    for (const socket of this.sockets.splice(0)) socket.close()
    try {
      await this.sessions?.delete(this.id)
      await this.sessions?.delete(this.other)
      const keys = [
        ...((await this.redis?.client.keys(`*${this.id}*`)) ?? []),
        `seq:${this.id}`,
        `seq:${this.other}`
      ]
      await this.redis?.client.del(...keys)
    } finally {
      await this.app?.close()
      this.app = undefined
      resetEnv()
    }
  }

  // Starts watching what the Nest exception layer of a gateway logs
  watchExceptions(): void {
    this.loggedErrors = jest.spyOn(Logger.prototype, 'error')
  }

  // What a handler or a global component that threw inside a gateway left in the log
  exceptionsLogged(): unknown[][] {
    // Nest adds the context inside Logger#error, after the spy recorded the arguments: the logger
    // that was called (`this`) is what names the exception layer
    const spy = this.loggedErrors
    if (spy === undefined) return []
    const calls: unknown[][] = spy.mock.calls
    return calls.filter(
      (_args, index) =>
        (spy.mock.contexts[index] as { context?: string } | undefined)?.context ===
        'WsExceptionsHandler'
    )
  }

  stopWatching(): void {
    this.loggedErrors?.mockRestore()
    this.loggedErrors = undefined
  }

  client(): FakeWhatsAppClient {
    const found = this.factory.clientFor(this.id)
    if (found === undefined) throw new Error('the session did not build a client')
    return found
  }

  call(
    method: 'GET' | 'POST',
    path: string,
    payload?: object
  ): ReturnType<NestFastifyApplication['inject']> {
    if (this.app === undefined) throw new Error('the application did not boot')
    return this.app.inject({
      method,
      url: path,
      headers: ADMIN,
      ...(payload !== undefined && { payload })
    })
  }

  // A ready session and an idle one
  async startSessions(): Promise<void> {
    expect((await this.call('POST', '/v1/sessions', { id: this.id })).statusCode).toBe(201)
    expect((await this.call('POST', `/v1/sessions/${this.id}/start`)).statusCode).toBe(200)
    this.client().emit({ event: 'ready', data: {} })
    await until(
      async () =>
        (await this.call('GET', `/v1/sessions/${this.id}`)).json<{ status: string }>().status ===
        'ready'
    )
    expect((await this.call('POST', '/v1/sessions', { id: this.other })).statusCode).toBe(201)
  }

  // A key of the session, or an admin key (it takes no scopes) when `sessionId` is null
  async createKey(
    name: string,
    scopes: string[],
    sessionId: string | null = this.id
  ): Promise<string> {
    const response = await this.call('POST', '/v1/api-keys', {
      name,
      ...(sessionId !== null && { sessionId }),
      ...(sessionId !== null && { scopes })
    })
    expect(response.statusCode).toBe(201)
    return response.json<{ key: string }>().key
  }

  connect(apiKey: string | undefined): Promise<Handshake> {
    return new Promise(resolve => {
      const socket = io(this.url, {
        auth: apiKey === undefined ? {} : { apiKey },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true
      })
      this.sockets.push(socket)
      socket.on('connect', () => resolve({ socket }))
      socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
        resolve({ error })
        socket.close()
      })
    })
  }

  async connected(apiKey: string): Promise<Socket> {
    const { socket, error } = await this.connect(apiKey)
    if (socket === undefined) throw new Error(`handshake refused: ${error?.data?.code}`)
    return socket
  }

  send(socket: Socket, event: string, body: unknown): Promise<Ack> {
    return socket.timeout(5000).emitWithAck(event, body) as Promise<Ack>
  }

  command(socket: Socket, op: string, extra: object = {}): Promise<Ack> {
    return this.send(socket, 'command', { op, sessionId: this.id, ...extra })
  }
}
