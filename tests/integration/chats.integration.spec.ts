import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import { WaChatNotFoundError, WaOperationError } from '../../src/whatsapp/wa-errors.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import {
  FakeWhatsAppClientFactory,
  buildMessageDto,
  type FakeWhatsAppClient
} from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const PEER = '5215500000001@c.us'
const MISSING = '5215599999999@c.us'
const GROUP = '120363000000000001@g.us'
const CHANNEL = '120363000000000002@newsletter'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

const chat = (id: string, overrides: object = {}) => ({
  id,
  archived: false,
  isGroup: false,
  isReadOnly: false,
  isMuted: false,
  muteExpiration: 0,
  name: 'Cliente',
  timestamp: 1_767_225_600,
  unreadCount: 2,
  pinned: false,
  isLocked: false,
  ...overrides
})
const group = chat(GROUP, {
  isGroup: true,
  owner: PEER,
  createdAt: '2026-01-01T00:00:00.000Z',
  description: null,
  participants: [{ id: PEER, isAdmin: true, isSuperAdmin: false }]
})
const channel = {
  id: CHANNEL,
  name: 'Novedades',
  description: 'Avisos',
  isChannel: true,
  isGroup: false,
  isReadOnly: true,
  unreadCount: 0,
  timestamp: 1_767_225_600,
  isMuted: false,
  muteExpiration: 0
}

// Step 5.7 over the whole application with real Postgres and Redis and the fake client in place of
// Chromium: every chats route goes through the guards, the registry and the service to the client
describe('chats API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const id = `chat-${randomUUID().slice(0, 8)}`
  const idleId = `${id}-idle`
  let app: NestFastifyApplication | undefined
  let sessions: SessionsRepository | undefined
  let redis: RedisService | undefined

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const client = (): FakeWhatsAppClient => {
    const found = factory.clientFor(id)
    if (found === undefined) throw new Error('the session did not build a client')
    return found
  }
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = ADMIN
  ) => application().inject({ method, url, headers, ...(payload !== undefined && { payload }) })
  const route = (chatId: string, path = '') => `/v1/sessions/${id}/chats/${chatId}${path}`
  const argsOf = (method: Parameters<FakeWhatsAppClient['callsOf']>[0]) =>
    client()
      .callsOf(method)
      .map(recorded => recorded.args)

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    setEnv({ DATABASE_URL, REDIS_URL, RATE_LIMIT_MAX: '100000' })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { SessionsRepository } =
      await import('../../src/database/repositories/sessions.repository.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    sessions = app.get(SessionsRepository)
    redis = app.get(RedisService)

    expect((await call('POST', '/v1/sessions', { id })).statusCode).toBe(201)
    expect((await call('POST', `/v1/sessions/${id}/start`)).statusCode).toBe(200)
    client().emit({ event: 'ready', data: {} })
    await until(
      async () =>
        (await call('GET', `/v1/sessions/${id}`)).json<{ status: string }>().status === 'ready'
    )
    // A session that never starts, to see what a route answers while the session is not ready
    expect((await call('POST', '/v1/sessions', { id: idleId })).statusCode).toBe(201)
    // The chats the fake page has; any other id is a chat WhatsApp Web does not know
    client().script('getChats', () => [group, channel, chat(PEER)])
    client().script('getChatById', chatId => {
      const found = [group, channel, chat(PEER)].find(candidate => candidate.id === chatId)
      if (found === undefined) throw new WaChatNotFoundError('getChatById')
      return found
    })
  })

  afterAll(async () => {
    try {
      await sessions?.delete(id)
      await sessions?.delete(idleId)
      const keys = [...((await redis?.client.keys(`*${id}*`)) ?? []), `seq:${id}`]
      await redis?.client.del(...keys)
    } finally {
      await app?.close()
    }
  })

  beforeEach(() => {
    client().calls.length = 0
  })

  describe('reads', () => {
    it('lists the chats with the fields of each kind', async () => {
      const response = await call('GET', `/v1/sessions/${id}/chats`)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [group, channel, chat(PEER)] })
    })

    it('reads one chat, and answers 404 CHAT_NOT_FOUND for one WhatsApp does not have', async () => {
      const found = await call('GET', route(GROUP))
      const missing = await call('GET', route(MISSING))

      expect(found.json()).toEqual(group)
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toMatchObject({ error: { code: 'CHAT_NOT_FOUND' } })
    })

    it('reads the messages of a chat with the limit and fromMe it was given', async () => {
      client().script('fetchMessages', () => [buildMessageDto({ body: 'hola' })])

      const response = await call('GET', `${route(PEER, '/messages')}?limit=20&fromMe=true`)
      const defaults = await call('GET', route(PEER, '/messages'))

      expect(response.statusCode).toBe(200)
      expect(response.json<{ items: { body: string }[] }>().items[0]?.body).toBe('hola')
      expect(defaults.statusCode).toBe(200)
      expect(argsOf('fetchMessages')).toEqual([
        [PEER, { limit: 20, fromMe: true }],
        [PEER, { limit: 50 }]
      ])
      expect((await call('GET', `${route(PEER, '/messages')}?limit=0`)).statusCode).toBe(400)
      expect((await call('GET', `${route(PEER, '/messages')}?other=1`)).statusCode).toBe(400)
    })

    it('reads the pinned messages, and answers 404 for a chat that is not there', async () => {
      client().script('getPinnedMessages', () => [buildMessageDto({ body: 'fijado' })])

      const response = await call('GET', route(PEER, '/pinned-messages'))
      const missing = await call('GET', route(MISSING, '/pinned-messages'))

      expect(response.json<{ items: { body: string }[] }>().items[0]?.body).toBe('fijado')
      expect(missing.statusCode).toBe(404)
    })
  })

  describe('chat.state', () => {
    it.each(['typing', 'recording', 'clear'] as const)('sends %s to the client', async state => {
      const response = await call('POST', route(PEER, '/state'), { state })

      expect(response.statusCode).toBe(204)
      expect(argsOf('sendChatState')).toEqual([[PEER, state]])
    })

    it('clears the indicator when the duration ends', async () => {
      const response = await call('POST', route(PEER, '/state'), {
        state: 'typing',
        durationMs: 50
      })

      expect(response.statusCode).toBe(204)
      expect(argsOf('sendChatState')).toEqual([[PEER, 'typing']])
      await until(() => argsOf('sendChatState').length === 2)
      expect(argsOf('sendChatState')[1]).toEqual([PEER, 'clear'])
    })

    it.each([
      ['an unknown state', { state: 'online' }],
      ['no state', {}],
      ['a clear with a duration', { state: 'clear', durationMs: 1000 }],
      ['a duration above 25 s', { state: 'typing', durationMs: 25_001 }],
      ['a duration of zero', { state: 'typing', durationMs: 0 }],
      ['a field that is not in the schema', { state: 'typing', extra: true }]
    ])('refuses %s with 400 and does not call the client', async (_name, body) => {
      const response = await call('POST', route(PEER, '/state'), body)

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
      expect(argsOf('sendChatState')).toEqual([])
    })

    it('answers 404 CHAT_NOT_FOUND when the page has no such chat', async () => {
      client().script('sendChatState', () => {
        throw new WaChatNotFoundError('sendChatState')
      })

      const response = await call('POST', route(MISSING, '/state'), { state: 'typing' })
      client().unscript('sendChatState')

      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'CHAT_NOT_FOUND' } })
    })

    it('answers a failure of WhatsApp as 502, and starts no countdown for it', async () => {
      client().failNext('sendChatState', new WaOperationError('sendChatState'))

      const response = await call('POST', route(PEER, '/state'), {
        state: 'typing',
        durationMs: 30
      })
      await sleep(120)

      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
      expect(argsOf('sendChatState')).toEqual([[PEER, 'typing']])
    })

    it('needs the send scope, and a session that is ready', async () => {
      const reader = await call('POST', '/v1/api-keys', {
        name: 'r',
        sessionId: id,
        scopes: ['read']
      })
      const denied = await call(
        'POST',
        route(PEER, '/state'),
        { state: 'typing' },
        { 'x-api-key': reader.json<{ key: string }>().key }
      )
      const notReady = await call('POST', `/v1/sessions/${idleId}/chats/${PEER}/state`, {
        state: 'typing'
      })

      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
      expect(notReady.statusCode).toBe(409)
      expect(notReady.json()).toMatchObject({ error: { code: 'SESSION_NOT_READY' } })
      expect(argsOf('sendChatState')).toEqual([])
    })
  })

  describe('actions', () => {
    it.each([
      ['POST', '/seen', 'sendSeen'],
      ['POST', '/mark-unread', 'markChatUnread'],
      ['POST', '/archive', 'archiveChat'],
      ['POST', '/unarchive', 'unarchiveChat'],
      ['POST', '/pin', 'pinChat'],
      ['POST', '/unpin', 'unpinChat'],
      ['POST', '/clear-messages', 'clearChatMessages'],
      ['POST', '/sync-history', 'syncHistory'],
      ['DELETE', '', 'deleteChat']
    ] as const)('%s %s answers 204 and calls %s', async (method, path, port) => {
      const response = await call(method, route(PEER, path))

      expect(response.statusCode).toBe(204)
      expect(argsOf(port)).toEqual([[PEER]])
    })

    it('answers 404 for a chat that is not there, and does not call the action', async () => {
      const response = await call('POST', route(MISSING, '/archive'))

      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'CHAT_NOT_FOUND' } })
      expect(argsOf('archiveChat')).toEqual([])
    })

    it('answers WHATSAPP_ERROR when WhatsApp says it did not do it', async () => {
      client().script('pinChat', () => false)

      const response = await call('POST', route(PEER, '/pin'))
      client().unscript('pinChat')

      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
    })

    it('mutes until a date and for ever, and unmutes', async () => {
      const end = new Date(Date.now() + 3_600_000)
      const timed = await call('POST', route(PEER, '/mute'), { until: end.toISOString() })
      const forever = await call('POST', route(PEER, '/mute'), {})
      const unmuted = await call('POST', route(PEER, '/unmute'))

      expect(timed.statusCode).toBe(200)
      expect(timed.json()).toEqual({
        isMuted: true,
        muteExpiration: Math.floor(end.getTime() / 1000)
      })
      expect(forever.json()).toEqual({ isMuted: true, muteExpiration: -1 })
      expect(unmuted.json()).toEqual({ isMuted: false, muteExpiration: 0 })
      expect(argsOf('muteChat')).toEqual([[PEER, end], [PEER]])
    })

    it.each([
      ['a date in the past', { until: '2020-01-01T00:00:00.000Z' }],
      ['text that is not a date', { until: 'tomorrow' }],
      ['a field that is not in the schema', { for: 10 }]
    ])('refuses a mute with %s', async (_name, body) => {
      const response = await call('POST', route(PEER, '/mute'), body)

      expect(response.statusCode).toBe(400)
      expect(argsOf('muteChat')).toEqual([])
    })

    it('needs the manage scope', async () => {
      const sender = await call('POST', '/v1/api-keys', {
        name: 's',
        sessionId: id,
        scopes: ['send']
      })

      const response = await call('POST', route(PEER, '/archive'), undefined, {
        'x-api-key': sender.json<{ key: string }>().key
      })

      expect(response.statusCode).toBe(403)
      expect(argsOf('archiveChat')).toEqual([])
    })
  })
})
