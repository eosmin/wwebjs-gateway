import { EventEmitter } from 'node:events'

import { Logger } from '@nestjs/common'
import wwebjs, { type Message } from 'whatsapp-web.js'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { parseEnv } from '../config/env.schema.js'
import { MessageDto } from '../types/dto.js'
import { WA_EVENTS, type WaEventName } from '../types/events.js'

import {
  WaChatNotFoundError,
  WaDisconnectedError,
  WaMappingError,
  WaOperationError,
  WaTimeoutError
} from './wa-errors.js'
import type { ClientEvent } from './whatsapp-client.port.js'
import {
  buildClientOptions,
  createWwebjsClientFactory,
  WwebjsAdapter,
  type WwebjsAdapterConfig
} from './wwebjs-adapter.js'

// Nothing here opens a browser: the adapter is wired to a real `Client` of the pinned library, which
// is only constructed, and the specs drive it with `emit` and spies. That proves the wiring and the
// contract against the real library; what WhatsApp Web answers is covered by the manual smoke test.

// Default import: Node cannot see the named exports of this CommonJS package (see the adapter)
// eslint-disable-next-line import-x/no-named-as-default-member -- see above
const { Client, NoAuth, LocalAuth, Events, Location, MessageMedia, Poll } = wwebjs

type WaClient = InstanceType<typeof Client>
type ClientMethod = {
  [K in keyof WaClient]: WaClient[K] extends (...args: never[]) => unknown ? K : never
}[keyof WaClient]

// `jest.spyOn` loses its types on the `Client` class (its Puppeteer members do not resolve under the
// CommonJS settings of the specs), so a method is replaced by a mock; the name is still checked
function stub(
  client: WaClient,
  method: Exclude<ClientMethod, 'on' | 'emit'>
): jest.Mock<Promise<unknown>, unknown[]> {
  const mock = jest.fn<Promise<unknown>, unknown[]>()
  Object.assign(client, { [method]: mock })
  return mock
}

const config = (overrides: Record<string, string> = {}): WwebjsAdapterConfig =>
  parseEnv({ ...TEST_ENV, ...overrides })

const GATEWAY_ONLY_EVENTS: readonly WaEventName[] = [
  'session_status',
  'message_batch',
  'message_sent',
  'message_failed',
  'chat_suppressed',
  'chat_unreachable',
  'ping',
  'session_error'
]

interface Harness {
  client: InstanceType<typeof Client>
  adapter: WwebjsAdapter
  events: ClientEvent[]
}

function harness(overrides: Record<string, string> = {}): Harness {
  jest.spyOn(Logger.prototype, 'debug').mockImplementation()
  const client = new Client({ authStrategy: new NoAuth() })
  const adapter = new WwebjsAdapter('support-line', client, config(overrides))
  const events: ClientEvent[] = []
  adapter.onEvent(event => events.push(event))
  return { client, adapter, events }
}

function ready({ client }: Harness): void {
  client.emit(Events.READY)
}

const wid = (serialized: string) => ({ _serialized: serialized })

// What wwebjs holds for a message: the typings describe it loosely, so the spec says what it carries
function waMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    id: wid('false_5215500000001@c.us_3EB0AAAA'),
    ack: 1,
    deviceType: 'android',
    body: 'Hola',
    broadcast: false,
    isStatus: false,
    isGif: false,
    isEphemeral: false,
    from: '5215500000001@c.us',
    fromMe: false,
    hasMedia: false,
    hasQuotedMsg: false,
    hasReaction: false,
    isForwarded: false,
    forwardingScore: 0,
    isStarred: false,
    vCards: [],
    mentionedIds: [],
    groupMentions: [],
    timestamp: 1_792_000_000,
    to: '5215500000002@c.us',
    type: 'chat',
    links: [],
    rawData: {},
    ...overrides
  } as unknown as Message
}

const waChat = (overrides: Record<string, unknown> = {}) => ({
  id: wid('5215500000001@c.us'),
  archived: false,
  isGroup: false,
  isReadOnly: false,
  isMuted: false,
  muteExpiration: 0,
  name: 'Ana',
  timestamp: 1_792_000_000,
  unreadCount: 0,
  pinned: false,
  isLocked: false,
  ...overrides
})

afterEach(() => {
  jest.restoreAllMocks()
})

const lastEvent = (events: ClientEvent[]): ClientEvent => {
  const event = events.at(-1)
  if (!event) throw new Error('no event was delivered')
  return event
}

describe('buildClientOptions', () => {
  it('builds a LocalAuth client per session and never sets userDataDir', () => {
    const options = buildClientOptions(config(), 'support-line', {})

    expect(options.authStrategy).toBeInstanceOf(LocalAuth)
    expect(options.authStrategy).toMatchObject({ clientId: 'support-line' })
    expect(options.puppeteer).toMatchObject({ headless: true })
    const launch = JSON.stringify(options.puppeteer)
    for (const arg of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']) {
      expect(launch).toContain(arg)
    }
    expect(options.puppeteer).not.toHaveProperty('userDataDir')
    expect(options.puppeteer).not.toHaveProperty('executablePath')
    expect(options.qrMaxRetries).toBe(6)
    expect(options.takeoverOnConflict).toBe(false)
  })

  it('runs the live build, with no snapshot lookup, when no version is pinned', () => {
    const options = buildClientOptions(config(), 's', {})

    expect(options.webVersionCache).toEqual({ type: 'none' })
    expect(options).not.toHaveProperty('webVersion')
  })

  it('pins a version from the local snapshots, strict by default', () => {
    const options = buildClientOptions(
      config({ WWEB_VERSION: '2.3000.1', WWEB_CACHE_PATH: '/data/wwebjs_cache' }),
      's',
      {}
    )

    expect(options.webVersion).toBe('2.3000.1')
    expect(options.webVersionCache).toEqual({
      type: 'local',
      path: '/data/wwebjs_cache',
      strict: true
    })
  })

  it('pins a version from remote snapshots', () => {
    const options = buildClientOptions(
      config({
        WWEB_VERSION: '2.3000.1',
        WWEB_VERSION_CACHE_TYPE: 'remote',
        WWEB_VERSION_REMOTE_PATH: 'https://example.com/{version}.html',
        WWEB_VERSION_STRICT: 'false'
      }),
      's',
      {}
    )

    expect(options.webVersionCache).toEqual({
      type: 'remote',
      remotePath: 'https://example.com/{version}.html',
      strict: false
    })
  })

  it('passes the browser binary, the device names, ffmpeg and the pairing request on', () => {
    const options = buildClientOptions(
      config({
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
        DEVICE_NAME: 'Gateway',
        BROWSER_NAME: 'Chrome',
        FFMPEG_PATH: '/usr/bin/ffmpeg',
        TAKEOVER_ON_CONFLICT: 'true'
      }),
      's',
      { pairWithPhoneNumber: { phoneNumber: '5215500000001', showNotification: false } }
    )

    expect(options.puppeteer).toMatchObject({ executablePath: '/usr/bin/chromium' })
    expect(options).toMatchObject({
      deviceName: 'Gateway',
      browserName: 'Chrome',
      ffmpegPath: '/usr/bin/ffmpeg',
      takeoverOnConflict: true,
      pairWithPhoneNumber: { phoneNumber: '5215500000001', showNotification: false }
    })
  })

  it('splits the proxy credentials from the browser argument', () => {
    const options = buildClientOptions(
      config({ PROXY_URL: 'http://user:p%40ss@proxy.example:8080' }),
      's',
      {}
    )

    const launch = JSON.stringify(options.puppeteer)
    expect(launch).toContain('--proxy-server=http://proxy.example:8080')
    // The password reaches Chromium nowhere but through proxyAuthentication
    expect(launch).not.toMatch(/p%40ss|p@ss/)
    expect(options.proxyAuthentication).toEqual({ username: 'user', password: 'p@ss' })
  })

  it('refuses a session id LocalAuth would refuse', () => {
    expect(() => buildClientOptions(config(), 'bad id', {})).toThrow()
  })
})

describe('createWwebjsClientFactory', () => {
  it('makes an adapter without starting a browser', () => {
    const client = createWwebjsClientFactory(config())('support-line', {})

    expect(client).toBeInstanceOf(WwebjsAdapter)
  })
})

describe('events', () => {
  it('listens to every event the library defines, and nothing it does not', () => {
    const { client } = harness()
    const libraryEvents = [...new Set(Object.values(Events))]

    for (const name of libraryEvents) expect(client.listenerCount(name)).toBeGreaterThan(0)
    // The gateway names the 31 events of the library the same way (events.ts)
    const gatewayNames = (Object.keys(WA_EVENTS) as WaEventName[]).filter(
      name => !GATEWAY_ONLY_EVENTS.includes(name)
    )
    expect([...libraryEvents].sort()).toEqual([...gatewayNames].sort())
  })

  it('maps what wwebjs emits to payloads that satisfy the event schemas', () => {
    const h = harness()
    const { client, events } = h
    const message = waMessage()
    const chat = waChat()

    client.emit('qr', '1@abc,def')
    client.emit('code', 'ABCD1234')
    client.emit('authenticated')
    client.emit('auth_failure', 'bad session')
    client.emit('ready')
    client.emit('loading_screen', 42, 'WhatsApp')
    client.emit('disconnected', 'LOGOUT')
    client.emit('change_state', 'CONNECTED')
    client.emit('change_battery', { battery: 80, plugged: true })
    client.emit('message', message)
    client.emit('message_create', message)
    client.emit('message_ack', message, 2)
    client.emit('message_edit', message, 'new', 'old')
    client.emit('message_revoke_everyone', message, undefined)
    client.emit('message_revoke_me', message)
    client.emit('message_ciphertext', message)
    client.emit('message_ciphertext_failed', message)
    client.emit('media_uploaded', message)
    client.emit('unread_count', chat)
    client.emit('chat_removed', chat)
    client.emit('chat_archived', chat, true, false)
    client.emit('contact_changed', message, 'a@c.us', 'b@c.us', true)
    client.emit('remote_session_saved')

    expect(events.map(event => event.event)).toEqual([
      'qr',
      'code',
      'authenticated',
      'auth_failure',
      'ready',
      'loading_screen',
      'disconnected',
      'change_state',
      'change_battery',
      'message',
      'message_create',
      'message_ack',
      'message_edit',
      'message_revoke_everyone',
      'message_revoke_me',
      'message_ciphertext',
      'message_ciphertext_failed',
      'media_uploaded',
      'unread_count',
      'chat_removed',
      'chat_archived',
      'contact_changed',
      'remote_session_saved'
    ])
    for (const event of events) {
      expect(() => WA_EVENTS[event.event].payload.parse(event.data)).not.toThrow()
    }
  })

  it('maps the group notifications, the reaction, the vote and the call as wwebjs really builds them', () => {
    const { client, events } = harness()
    const notification = {
      id: wid('n1'),
      author: 'a@c.us',
      body: '',
      chatId: 'g@g.us',
      recipientIds: [wid('b@c.us')],
      timestamp: 1,
      type: 'add'
    }

    for (const name of [
      'group_join',
      'group_leave',
      'group_update',
      'group_admin_changed',
      'group_membership_request'
    ]) {
      client.emit(name, notification)
    }
    client.emit('message_reaction', {
      id: wid('r1'),
      orphan: 0,
      timestamp: 1,
      reaction: '👍',
      read: false,
      msgId: wid('m1'),
      senderId: 'a@c.us'
    })
    client.emit('vote_update', {
      voter: wid('a@c.us'),
      selectedOptions: [{ localId: 1, name: 'Tacos' }],
      interractedAtTs: 99,
      parentMessage: { id: wid('poll1') }
    })
    client.emit('call', {
      id: 'c1',
      from: wid('a@c.us'),
      timestamp: 1,
      isVideo: false,
      isGroup: false,
      fromMe: false,
      canHandleLocally: false,
      webClientShouldHandle: false,
      participants: {}
    })

    expect(events).toHaveLength(8)
    for (const event of events) {
      expect(() => WA_EVENTS[event.event].payload.parse(event.data)).not.toThrow()
    }
    expect(events.find(event => event.event === 'group_join')?.data).toMatchObject({
      recipientIds: ['b@c.us']
    })
    expect(events.find(event => event.event === 'vote_update')?.data).toMatchObject({
      voter: 'a@c.us',
      selectedOptions: [{ id: 1, name: 'Tacos' }]
    })
  })

  it('turns the revoked message into null when wwebjs could not capture it', () => {
    const { client, events } = harness()

    client.emit('message_revoke_everyone', waMessage(), undefined)

    expect(lastEvent(events).data).toMatchObject({ revokedMessage: null })
  })

  it('keeps the sanitized raw data out of the event when INCLUDE_RAW is off', () => {
    const { client, events } = harness({ INCLUDE_RAW: 'false' })

    client.emit('message', waMessage({ rawData: { ctwaContext: { title: 'Ad' } } }))

    const data = lastEvent(events).data as { raw?: unknown; origin?: unknown }
    expect(data.raw).toBeUndefined()
    expect(data.origin).toMatchObject({ kind: 'click_to_whatsapp_ad', title: 'Ad' })
  })

  it('survives an event it cannot map and keeps delivering the next ones', () => {
    const { client, events } = harness()
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()

    expect(() => client.emit('message', { id: wid('broken'), body: 'secret text' })).not.toThrow()
    client.emit('qr', 'next')

    expect(events.map(event => event.event)).toEqual(['qr'])
    // The log says what failed, never what the message said
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('message event failed'))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret text')
  })

  it('tells the skipped listener which event it could not map', () => {
    const { client, adapter } = harness()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    const skipped: string[] = []
    const stop = adapter.onSkipped(event => skipped.push(event))

    client.emit('message', { body: 'a message without an id' })
    stop()
    client.emit('message', { body: 'another one' })

    expect(skipped).toEqual(['message'])
  })

  it('isolates a skipped listener that throws from the others', () => {
    const { client, adapter } = harness()
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    const seen: string[] = []
    adapter.onSkipped(() => {
      throw new Error('boom')
    })
    adapter.onSkipped(event => seen.push(event))

    expect(() => client.emit('message', { body: 'no id' })).not.toThrow()
    expect(() => client.emit('qr', undefined)).not.toThrow()

    expect(seen).toEqual(['message'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped-event listener failed'))
  })

  it('isolates a listener that throws from the others', () => {
    const { client, adapter, events } = harness()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    adapter.onEvent(() => {
      throw new Error('boom')
    })

    expect(() => client.emit('qr', 'x')).not.toThrow()
    expect(events).toHaveLength(1)
  })

  it('stops delivering to a listener that unsubscribed', () => {
    const { client, adapter } = harness()
    const seen: ClientEvent[] = []
    const stop = adapter.onEvent(event => seen.push(event))

    client.emit('qr', 'a')
    stop()
    client.emit('qr', 'b')

    expect(seen).toHaveLength(1)
  })
})

describe('calls', () => {
  it('refuses a call before the session is ready, without touching the library', async () => {
    const { client, adapter } = harness()
    const getChats = stub(client, 'getChats')

    const error: unknown = await adapter.getChats().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaDisconnectedError)
    expect(error).toMatchObject({ operation: 'getChats', dispatched: false })
    expect(getChats).not.toHaveBeenCalled()
  })

  it('answers once the session is ready and refuses again after it disconnects', async () => {
    const h = harness()
    stub(h.client, 'getChats').mockResolvedValue([])
    ready(h)

    await expect(h.adapter.getChats()).resolves.toEqual([])

    h.client.emit('disconnected', 'NAVIGATION')
    await expect(h.adapter.getChats()).rejects.toBeInstanceOf(WaDisconnectedError)
  })

  it('lets the calls that bring a session back run before it is ready', async () => {
    const { client, adapter } = harness()
    stub(client, 'getState').mockResolvedValue(undefined)
    stub(client, 'getWWebVersion').mockResolvedValue('2.3000.1')
    const destroy = stub(client, 'destroy').mockResolvedValue(undefined)

    await expect(adapter.getState()).resolves.toBeNull()
    await expect(adapter.getWWebVersion()).resolves.toBe('2.3000.1')
    await expect(adapter.destroy()).resolves.toBeUndefined()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('translates a dead page into WaDisconnectedError with the call in flight', async () => {
    const h = harness()
    stub(h.client, 'getChats').mockRejectedValue(
      new Error('Protocol error (Runtime.callFunctionOn): Target closed.')
    )
    ready(h)

    const error: unknown = await h.adapter.getChats().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaDisconnectedError)
    expect(error).toMatchObject({ dispatched: true })
  })

  it('abandons a call that hangs', async () => {
    const h = harness({ WA_CALL_TIMEOUT_MS: '20' })
    stub(h.client, 'getChatById').mockReturnValue(new Promise(() => undefined))
    ready(h)

    await expect(h.adapter.getChatById('c@c.us')).rejects.toBeInstanceOf(WaTimeoutError)
  })

  it('tells a mapper that fails from a library that fails, in the error and in the log', async () => {
    const h = harness()
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation()
    const getChats = stub(h.client, 'getChats')
    ready(h)

    // A chat whose data the mapper cannot read
    getChats.mockResolvedValueOnce([{ id: undefined }])
    await expect(h.adapter.getChats()).rejects.toBeInstanceOf(WaMappingError)
    expect(warn).toHaveBeenCalledWith('getChats failed (TypeError)')

    // A TypeError that comes out of the library itself is not a mapper of ours
    warn.mockClear()
    getChats.mockRejectedValueOnce(new TypeError('x is undefined'))
    await expect(h.adapter.getChats()).rejects.toBeInstanceOf(WaOperationError)
    expect(warn).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('getChats failed (TypeError)')
  })

  // WhatsApp took the message by the time the answer is mapped: it must read as an unknown outcome,
  // never as "not sent"
  it('reports a send whose result cannot be mapped as dispatched and unknown', async () => {
    const h = harness()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    stub(h.client, 'sendMessage').mockResolvedValue(waMessage({ id: undefined }))
    ready(h)

    const error: unknown = await h.adapter
      .sendMessage('c@c.us', { type: 'text', body: 'hola' })
      .catch((e: unknown) => e)

    // Nothing timed out: it is a mapping failure, which the send worker also reads as unknown
    expect(error).toBeInstanceOf(WaMappingError)
    expect(error).toMatchObject({ operation: 'sendMessage', details: { kind: 'mapping' } })
  })

  it.each([
    [
      'getPollVotes',
      'getPollVotes',
      [{ voter: undefined }],
      (a: WwebjsAdapter) => a.getPollVotes('m')
    ],
    [
      'getGroupMembershipRequests',
      'getGroupMembershipRequests',
      [{ id: undefined }],
      (a: WwebjsAdapter) => a.getGroupMembershipRequests('g@g.us')
    ]
  ] as const)(
    'maps the answer of %s inside the mapping wrapper',
    async (_name, method, data, call) => {
      const h = harness()
      jest.spyOn(Logger.prototype, 'warn').mockImplementation()
      stub(h.client, method).mockResolvedValue(data)
      ready(h)

      await expect(call(h.adapter)).rejects.toBeInstanceOf(WaMappingError)
    }
  )

  it('answers null for a message that is not in the page', async () => {
    const h = harness()
    stub(h.client, 'getMessageById').mockResolvedValue(undefined)
    ready(h)

    await expect(h.adapter.getMessageById('x')).resolves.toBeNull()
    await expect(h.adapter.starMessage('x')).rejects.toBeInstanceOf(WaOperationError)
  })

  it('answers null for media that is gone', async () => {
    const h = harness()
    const message = { downloadMedia: jest.fn().mockResolvedValue(undefined) }
    stub(h.client, 'getMessageById').mockResolvedValue(message)
    ready(h)

    await expect(h.adapter.downloadMedia('m1')).resolves.toBeNull()
  })

  it('maps downloaded media to the fields of the port', async () => {
    const h = harness()
    const media = new MessageMedia('image/png', 'AAAA', 'a.png', 3)
    const message = { downloadMedia: jest.fn().mockResolvedValue(media) }
    stub(h.client, 'getMessageById').mockResolvedValue(message)
    ready(h)

    await expect(h.adapter.downloadMedia('m1')).resolves.toEqual({
      mimetype: 'image/png',
      data: 'AAAA',
      filename: 'a.png',
      filesize: 3
    })
  })

  it('sends text with the options as given and answers a DTO', async () => {
    const h = harness()
    const send = stub(h.client, 'sendMessage').mockResolvedValue(waMessage({ fromMe: true }))
    ready(h)

    const dto = await h.adapter.sendMessage(
      '5215500000001@c.us',
      { type: 'text', body: 'Hola' },
      {
        linkPreview: false,
        quotedMessageId: 'q1'
      }
    )

    expect(send).toHaveBeenCalledWith('5215500000001@c.us', 'Hola', {
      linkPreview: false,
      quotedMessageId: 'q1'
    })
    expect(dto).toMatchObject({
      id: 'false_5215500000001@c.us_3EB0AAAA',
      chatId: '5215500000002@c.us'
    })
  })

  it('builds the wwebjs content for media, location and poll', async () => {
    const h = harness()
    const send = stub(h.client, 'sendMessage').mockResolvedValue(waMessage())
    ready(h)

    await h.adapter.sendMessage('c@c.us', {
      type: 'media',
      media: { mimetype: 'image/png', data: 'AAAA', filename: 'a.png' }
    })
    await h.adapter.sendMessage('c@c.us', { type: 'location', latitude: 19.4, longitude: -99.1 })
    await h.adapter.sendMessage('c@c.us', { type: 'poll', name: 'Lunch?', options: ['A', 'B'] })

    const contents = send.mock.calls.map((args: unknown[]) => args[1])
    expect(contents[0]).toBeInstanceOf(MessageMedia)
    expect(contents[0]).toMatchObject({ mimetype: 'image/png', data: 'AAAA', filename: 'a.png' })
    expect(contents[1]).toBeInstanceOf(Location)
    expect(contents[2]).toBeInstanceOf(Poll)
  })

  it('answers the participants of an added group member as WhatsApp sends them', async () => {
    const h = harness()
    const group = {
      ...waChat({ isGroup: true }),
      participants: [],
      addParticipants: jest
        .fn()
        .mockResolvedValue({ 'a@c.us': { code: 200, message: 'ok', isInviteV4Sent: false } })
    }
    stub(h.client, 'getChatById').mockResolvedValue(group)
    ready(h)

    await expect(h.adapter.addParticipants('g@g.us', ['a@c.us'])).resolves.toEqual({
      'a@c.us': { code: 200, message: 'ok', isInviteV4Sent: false }
    })
  })

  it('answers a chat the page does not have as not found, in the chat operations and the group ones', async () => {
    const h = harness()
    stub(h.client, 'getChatById').mockResolvedValue(undefined)
    ready(h)

    await expect(h.adapter.getChatById('x@c.us')).rejects.toBeInstanceOf(WaChatNotFoundError)
    await expect(h.adapter.sendChatState('x@c.us', 'typing')).rejects.toBeInstanceOf(
      WaChatNotFoundError
    )
    await expect(h.adapter.fetchMessages('x@c.us')).rejects.toBeInstanceOf(WaChatNotFoundError)
    await expect(h.adapter.clearChatMessages('x@c.us')).rejects.toBeInstanceOf(WaChatNotFoundError)
    await expect(h.adapter.deleteChat('x@c.us')).rejects.toBeInstanceOf(WaChatNotFoundError)
    await expect(h.adapter.setGroupSubject('x@g.us', 'x')).rejects.toBeInstanceOf(
      WaChatNotFoundError
    )
  })

  it('refuses a group call on a chat that is not a group', async () => {
    const h = harness()
    stub(h.client, 'getChatById').mockResolvedValue(waChat())
    ready(h)

    await expect(h.adapter.setGroupSubject('5215500000001@c.us', 'x')).rejects.toBeInstanceOf(
      WaOperationError
    )
  })

  it('sanitizes the invite info instead of handing a wwebjs object out', async () => {
    const h = harness()
    const info: Record<string, unknown> = {
      id: wid('g@g.us'),
      subject: 'Team',
      fn: () => undefined
    }
    info['self'] = info
    stub(h.client, 'getInviteInfo').mockResolvedValue(info)
    ready(h)

    const result = await h.adapter.getInviteInfo('code')

    expect(result).toEqual({ id: { _serialized: 'g@g.us' }, subject: 'Team', self: '[circular]' })
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it('rejects a call it never saw, and rejects one it did through the wwebjs object', async () => {
    const h = harness()
    ready(h)
    const reject = jest.fn().mockResolvedValue(undefined)
    h.client.emit('call', {
      id: 'c1',
      timestamp: 1,
      isVideo: false,
      isGroup: false,
      fromMe: false,
      canHandleLocally: false,
      webClientShouldHandle: false,
      reject
    })

    await expect(h.adapter.rejectCall('nope')).rejects.toBeInstanceOf(WaOperationError)
    await expect(h.adapter.rejectCall('c1')).resolves.toBeUndefined()
    expect(reject).toHaveBeenCalledTimes(1)
    await expect(h.adapter.rejectCall('c1')).rejects.toBeInstanceOf(WaOperationError)
  })

  it('answers the client info only once WhatsApp Web gave it', async () => {
    const h = harness()
    ready(h)

    await expect(h.adapter.getClientInfo()).rejects.toBeInstanceOf(WaDisconnectedError)

    Object.assign(h.client, {
      info: {
        wid: wid('5215500000001@c.us'),
        me: wid('5215500000001@c.us'),
        platform: 'android',
        pushname: 'Ana'
      }
    })
    await expect(h.adapter.getClientInfo()).resolves.toEqual({
      wid: '5215500000001@c.us',
      me: '5215500000001@c.us',
      platform: 'android',
      pushname: 'Ana'
    })
  })
})

describe('browser failures', () => {
  // The part of a Puppeteer browser/page the adapter listens to
  const fake = (): EventEmitter => new EventEmitter()

  function withBrowser(h: Harness): { browser: EventEmitter; page: EventEmitter } {
    const browser = fake()
    const page = fake()
    Object.assign(h.client, { pupBrowser: browser, pupPage: page })
    return { browser, page }
  }

  const errors = (events: ClientEvent[]) => events.filter(event => event.event === 'session_error')

  it('reports a browser that disconnected once, with a code the manager can act on', () => {
    const h = harness()
    const { browser, page } = withBrowser(h)
    h.client.emit('qr', 'x')

    browser.emit('disconnected')
    page.emit('close')

    expect(errors(h.events)).toEqual([
      {
        event: 'session_error',
        data: { code: 'BROWSER_DISCONNECTED', message: 'The browser disconnected' }
      }
    ])
  })

  it('reports a crashed page and refuses calls afterwards', async () => {
    const h = harness()
    const { page } = withBrowser(h)
    ready(h)

    page.emit('error', new Error('Page crashed!'))

    expect(errors(h.events)).toMatchObject([{ data: { code: 'PAGE_CRASHED' } }])
    await expect(h.adapter.getChats()).rejects.toBeInstanceOf(WaDisconnectedError)
  })

  it('does not report the browser that the adapter closed itself', async () => {
    const h = harness()
    const { browser } = withBrowser(h)
    stub(h.client, 'destroy').mockResolvedValue(undefined)
    h.client.emit('qr', 'x')

    await h.adapter.destroy()
    browser.emit('disconnected')

    expect(errors(h.events)).toHaveLength(0)
  })

  it('does not report the browser that closes after a disconnect event', () => {
    const h = harness()
    const { browser } = withBrowser(h)
    h.client.emit('qr', 'x')

    h.client.emit('disconnected', 'Max qrcode retries reached')
    browser.emit('disconnected')

    expect(errors(h.events)).toHaveLength(0)
  })

  it('watches each browser once', () => {
    const h = harness()
    const { browser } = withBrowser(h)

    h.client.emit('qr', 'a')
    h.client.emit('qr', 'b')
    h.client.emit('loading_screen', 1, 'x')

    expect(browser.listenerCount('disconnected')).toBe(1)
  })
})

describe('values of the events', () => {
  it('carries the right value in each field', () => {
    const { client, events } = harness()
    const message = waMessage()

    client.emit('message_ack', message, 3)
    client.emit('message_edit', message, 'new text', 'old text')
    client.emit('contact_changed', message, 'old@c.us', 'new@c.us', true)
    client.emit('loading_screen', 42, 'WhatsApp')
    client.emit('change_state', 'CONFLICT')
    client.emit('chat_archived', waChat(), true, false)

    expect(events.map(event => event.data)).toMatchObject([
      { ack: 3 },
      { newBody: 'new text', prevBody: 'old text' },
      { oldId: 'old@c.us', newId: 'new@c.us', isContact: true },
      { percent: '42', message: 'WhatsApp' },
      { state: 'CONFLICT' },
      { currState: true, prevState: false }
    ])
  })

  it('caps the text of an auth failure, which is the library’s and not ours', () => {
    const { client, events } = harness()

    client.emit('auth_failure', 'x'.repeat(5000))

    expect((lastEvent(events).data as { message: string }).message).toHaveLength(200)
  })
})

describe('session ending', () => {
  const errors = (events: ClientEvent[]) => events.filter(event => event.event === 'session_error')

  function withBrowser(h: Harness): { browser: EventEmitter; page: EventEmitter } {
    const browser = new EventEmitter()
    const page = new EventEmitter()
    Object.assign(h.client, { pupBrowser: browser, pupPage: page })
    return { browser, page }
  }

  it('does not report the browser that closes after a logout', async () => {
    const h = harness()
    const { browser } = withBrowser(h)
    stub(h.client, 'logout').mockResolvedValue(undefined)
    ready(h)

    await h.adapter.logout()
    browser.emit('disconnected')

    expect(errors(h.events)).toHaveLength(0)
    await expect(h.adapter.getChats()).rejects.toBeInstanceOf(WaDisconnectedError)
  })

  it('does not report the browser wwebjs closes after an auth failure', () => {
    const h = harness()
    const { browser } = withBrowser(h)
    h.client.emit('qr', 'x')

    h.client.emit('auth_failure', 'bad session')
    browser.emit('disconnected')

    expect(errors(h.events)).toHaveLength(0)
  })

  it('reports a second failure after the session became ready again', () => {
    const h = harness()
    const { browser, page } = withBrowser(h)
    h.client.emit('qr', 'x')
    browser.emit('disconnected')

    ready(h)
    page.emit('error', new Error('crash'))

    expect(errors(h.events).map(event => event.data)).toMatchObject([
      { code: 'BROWSER_DISCONNECTED' },
      { code: 'PAGE_CRASHED' }
    ])
  })

  it('reports a page that closed on its own, and refuses calls after a browser failure', async () => {
    const h = harness()
    const { browser, page } = withBrowser(h)
    h.client.emit('qr', 'x')
    ready(h)

    page.emit('close')
    expect(errors(h.events)).toMatchObject([{ data: { code: 'PAGE_CLOSED' } }])
    await expect(h.adapter.getChats()).rejects.toBeInstanceOf(WaDisconnectedError)

    const other = harness()
    const { browser: otherBrowser } = withBrowser(other)
    other.client.emit('qr', 'x')
    ready(other)
    otherBrowser.emit('disconnected')
    await expect(other.adapter.getChats()).rejects.toBeInstanceOf(WaDisconnectedError)
    expect(browser.listenerCount('disconnected')).toBe(1)
  })

  it('attaches to the browser that initialize created', async () => {
    const h = harness()
    const browser = new EventEmitter()
    stub(h.client, 'initialize').mockImplementation(() => {
      Object.assign(h.client, { pupBrowser: browser, pupPage: new EventEmitter() })
      return Promise.resolve(undefined)
    })

    await h.adapter.initialize()
    browser.emit('disconnected')

    expect(errors(h.events)).toHaveLength(1)
  })

  it('kills a browser that destroy could not close, and the one a late initialize launches', async () => {
    const h = harness({ WA_CALL_TIMEOUT_MS: '20' })
    const kill = jest.fn()
    Object.assign(h.client, {
      pupBrowser: Object.assign(new EventEmitter(), { process: () => ({ kill }) })
    })
    stub(h.client, 'destroy').mockReturnValue(new Promise(() => undefined))
    let finishLaunch: () => void = () => undefined
    stub(h.client, 'initialize').mockReturnValue(
      new Promise<void>(resolve => {
        finishLaunch = () => resolve()
      })
    )
    const initializing = h.adapter.initialize().catch((e: unknown) => e)
    // let initialize register, then abandon it at its deadline by destroying the session
    await Promise.resolve()

    await expect(h.adapter.destroy()).rejects.toBeInstanceOf(WaTimeoutError)
    expect(kill).toHaveBeenCalledWith('SIGKILL')

    finishLaunch()
    await initializing
    await new Promise(resolve => setImmediate(resolve))
    expect(kill).toHaveBeenCalledTimes(2)
  })
})

describe('deadlines', () => {
  it('gives the calls that send or scale with their input more time than a query', async () => {
    jest.useFakeTimers()
    try {
      const h = harness({ WA_CALL_TIMEOUT_MS: '1000' })
      stub(h.client, 'sendMessage').mockReturnValue(new Promise(() => undefined))
      stub(h.client, 'getChatById').mockReturnValue(new Promise(() => undefined))
      ready(h)

      const send = h.adapter
        .sendMessage('c@c.us', { type: 'text', body: 'x' })
        .catch((e: unknown) => e)
      const query = h.adapter.getChatById('c@c.us').catch((e: unknown) => e)

      await jest.advanceTimersByTimeAsync(1500)
      // The query is over; the send is still waiting
      expect(await query).toBeInstanceOf(WaTimeoutError)
      let sendSettled = false
      void send.then(() => {
        sendSettled = true
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(sendSettled).toBe(false)

      await jest.advanceTimersByTimeAsync(180_000)
      const error = await send
      expect(error).toBeInstanceOf(WaTimeoutError)
      // A send that timed out is an unknown outcome: it must say it was dispatched
      expect(error).toMatchObject({ operation: 'sendMessage', dispatched: true })
    } finally {
      jest.useRealTimers()
    }
  })

  it('abandons an initialize that hangs and translates one that throws a string', async () => {
    jest.useFakeTimers()
    try {
      const hung = harness()
      stub(hung.client, 'initialize').mockReturnValue(new Promise(() => undefined))
      const hang = hung.adapter.initialize().catch((e: unknown) => e)
      await jest.advanceTimersByTimeAsync(180_000)
      expect(await hang).toBeInstanceOf(WaTimeoutError)
    } finally {
      jest.useRealTimers()
    }

    const thrown = harness()
    // wwebjs throws the string 'auth timeout'
    stub(thrown.client, 'initialize').mockImplementation(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- wwebjs throws strings
      Promise.reject('auth timeout')
    )
    await expect(thrown.adapter.initialize()).rejects.toBeInstanceOf(WaOperationError)
  })
})

describe('sending', () => {
  it('reads a library failure marked as after the dispatch as an unknown outcome and warns', async () => {
    const h = harness()
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    const marked = Object.assign(
      new Error('sent, result not built', { cause: new TypeError('x') }),
      {
        afterDispatch: true
      }
    )
    stub(h.client, 'sendMessage').mockRejectedValue(marked)
    ready(h)

    const error: unknown = await h.adapter
      .sendMessage('c@c.us', { type: 'text', body: 'x' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaMappingError)
    expect(error).toMatchObject({ operation: 'sendMessage', details: { kind: 'mapping' } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sendMessage failed after the page'))
  })

  it('reads a send that answers nothing as an unknown outcome, not as a clean result', async () => {
    const h = harness()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    stub(h.client, 'sendMessage').mockResolvedValue(undefined)
    ready(h)

    const error: unknown = await h.adapter
      .sendMessage('c@c.us', { type: 'text', body: 'x' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaMappingError)
  })

  // The patched Client.sendMessage answers null when nothing was sent; Channel.sendMessage and
  // Message.reply return it unchanged, so all three paths must read it as a definite failure
  it.each([
    [
      'sendMessage',
      (h: Harness): Promise<unknown> => {
        stub(h.client, 'sendMessage').mockResolvedValue(null)
        return h.adapter.sendMessage('c@c.us', { type: 'text', body: 'x' })
      }
    ],
    [
      'sendChannelMessage',
      (h: Harness): Promise<unknown> => {
        const channel = {
          ...waChat(),
          isChannel: true,
          sendMessage: jest.fn().mockResolvedValue(null)
        }
        stub(h.client, 'getChatById').mockResolvedValue(channel)
        return h.adapter.sendChannelMessage('n@newsletter', { type: 'text', body: 'x' })
      }
    ],
    [
      'replyToMessage',
      (h: Harness): Promise<unknown> => {
        stub(h.client, 'getMessageById').mockResolvedValue({
          reply: jest.fn().mockResolvedValue(null)
        })
        return h.adapter.replyToMessage('m1', { type: 'text', body: 'x' })
      }
    ]
  ])(
    'reports nothing sent by %s as a definite failure, not an unknown outcome',
    async (operation, run) => {
      const h = harness()
      ready(h)

      const error: unknown = await run(h).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(WaOperationError)
      expect(error).not.toBeInstanceOf(WaMappingError)
      expect(error).toMatchObject({ code: 'WHATSAPP_ERROR', operation })
    }
  )

  it('reports a send whose result cannot be read as an unknown outcome, never as not sent', async () => {
    const h = harness()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    stub(h.client, 'sendMessage').mockResolvedValue({ id: wid('broken') })
    ready(h)

    const error: unknown = await h.adapter
      .sendMessage('c@c.us', { type: 'text', body: 'x' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaMappingError)
    expect(error).not.toBeInstanceOf(WaTimeoutError)
  })

  it('reports a send that died with the page as dispatched', async () => {
    const h = harness()
    stub(h.client, 'sendMessage').mockRejectedValue(new Error('Target closed'))
    ready(h)

    await expect(
      h.adapter.sendMessage('c@c.us', { type: 'text', body: 'x' })
    ).rejects.toMatchObject({
      dispatched: true
    })
  })

  it('sends without options, and builds contacts and event content', async () => {
    const h = harness()
    const send = stub(h.client, 'sendMessage').mockResolvedValue(waMessage())
    const contact = { id: wid('p@c.us') }
    const getContact = stub(h.client, 'getContactById').mockResolvedValue(contact)
    ready(h)

    await h.adapter.sendMessage('c@c.us', { type: 'text', body: 'x' })
    await h.adapter.sendMessage('c@c.us', { type: 'contacts', contactIds: ['p@c.us', 'q@c.us'] })
    await h.adapter.sendMessage('c@c.us', {
      type: 'event',
      name: 'Party',
      startTime: new Date('2026-12-01T10:00:00Z')
    })

    expect(send.mock.calls[0]?.[2]).toEqual({})
    expect(getContact).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1]).toEqual([contact, contact])
    expect(send.mock.calls[2]?.[1]).toMatchObject({ name: 'Party' })
  })

  // A real poll and a real event came back from WhatsApp without these flags, and the response
  // schema of the send routes turned the successful send into a 500
  it('answers a send whose message lacks the flags WhatsApp omits with a valid DTO', async () => {
    const h = harness()
    stub(h.client, 'sendMessage').mockResolvedValue(
      waMessage({ broadcast: undefined, isEphemeral: undefined, isForwarded: undefined })
    )
    ready(h)

    const sent = await h.adapter.sendMessage('c@c.us', {
      type: 'poll',
      name: 'q',
      options: ['a', 'b']
    })

    expect(MessageDto.parse(sent)).toEqual(sent)
    expect(sent).toMatchObject({ broadcast: false, isEphemeral: false, isForwarded: false })
  })

  // The library builds a call link whenever `callType` is not 'none' and WhatsApp Web no longer has
  // the module for it, so an event without a call must say 'none' explicitly
  it('asks for no call link when the event has no call type', async () => {
    const h = harness()
    const send = stub(h.client, 'sendMessage').mockResolvedValue(waMessage())
    ready(h)
    const base = {
      type: 'event',
      name: 'Party',
      startTime: new Date('2026-12-01T10:00:00Z')
    } as const

    await h.adapter.sendMessage('c@c.us', base)
    await h.adapter.sendMessage('c@c.us', { ...base, callType: 'video' })

    expect(send.mock.calls[0]?.[1]).toMatchObject({
      eventSendOptions: { callType: 'none' }
    })
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      eventSendOptions: { callType: 'video' }
    })
  })

  it('sends to a channel, as text or media, and refuses a chat that is not a channel', async () => {
    const h = harness()
    const sendMessage = jest.fn<Promise<Message>, unknown[]>().mockResolvedValue(waMessage())
    const channel = { ...waChat(), isChannel: true, sendMessage }
    const getChat = stub(h.client, 'getChatById').mockResolvedValue(channel)
    ready(h)

    await h.adapter.sendChannelMessage(
      'n@newsletter',
      { type: 'text', body: 'hi' },
      { caption: 'c' }
    )
    await h.adapter.sendChannelMessage('n@newsletter', {
      type: 'media',
      media: { mimetype: 'image/png', data: 'AAAA' }
    })
    expect(sendMessage.mock.calls[0]).toEqual(['hi', { caption: 'c' }])
    expect(sendMessage.mock.calls[1]?.[0]).toBeInstanceOf(MessageMedia)

    getChat.mockResolvedValue(waChat())
    await expect(
      h.adapter.sendChannelMessage('x@c.us', { type: 'text', body: 'hi' })
    ).rejects.toBeInstanceOf(WaOperationError)
  })

  it('replies, forwards and edits through the message', async () => {
    const h = harness()
    const message = {
      reply: jest.fn().mockResolvedValue(waMessage()),
      forward: jest.fn().mockResolvedValue(undefined),
      edit: jest.fn().mockResolvedValue(waMessage()),
      editScheduledEvent: jest.fn().mockResolvedValue(null)
    }
    stub(h.client, 'getMessageById').mockResolvedValue(message)
    ready(h)

    await h.adapter.replyToMessage('m1', { type: 'text', body: 'r' }, 'chat@c.us', {
      linkPreview: false
    })
    await h.adapter.forwardMessage('m1', 'other@c.us')
    await h.adapter.editMessage('m1', { type: 'text', body: 'edited' }, { linkPreview: true })
    const edited = await h.adapter.editScheduledEvent('m1', {
      type: 'event',
      name: 'Party',
      startTime: new Date('2026-12-01T10:00:00Z')
    })

    expect(message.reply).toHaveBeenCalledWith('r', 'chat@c.us', { linkPreview: false })
    expect(message.forward).toHaveBeenCalledWith('other@c.us')
    expect(message.edit).toHaveBeenCalledWith('edited', { linkPreview: true })
    expect(edited).toBeNull()
  })
})

describe('boundaries', () => {
  it('turns a bad participants answer into WaOperationError without echoing it', async () => {
    const h = harness()
    const group = {
      ...waChat({ isGroup: true }),
      participants: [],
      addParticipants: jest.fn().mockResolvedValue({ 'a@c.us': { code: 'secret-5215500000001' } })
    }
    stub(h.client, 'getChatById').mockResolvedValue(group)
    ready(h)

    const error: unknown = await h.adapter
      .addParticipants('g@g.us', ['a@c.us'])
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaOperationError)
    expect((error as Error).message).not.toContain('5215500000001')
  })

  it('keeps the text answers of createGroup and addParticipants', async () => {
    const h = harness()
    stub(h.client, 'createGroup').mockResolvedValue('Some participants could not be added')
    const group = {
      ...waChat({ isGroup: true }),
      participants: [],
      addParticipants: jest.fn().mockResolvedValue('not allowed')
    }
    stub(h.client, 'getChatById').mockResolvedValue(group)
    ready(h)

    await expect(h.adapter.createGroup('t', ['a@c.us'])).resolves.toBe(
      'Some participants could not be added'
    )
    await expect(h.adapter.addParticipants('g@g.us', ['a@c.us'])).resolves.toBe('not allowed')
  })

  it('maps a group notification with a malformed id to nothing instead of throwing', () => {
    const { client, events } = harness()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()

    expect(() => client.emit('group_join', { id: 42, recipientIds: [] })).not.toThrow()

    expect(events).toHaveLength(0)
  })

  it('maps a business contact whose profile is not loaded as a plain contact', async () => {
    const h = harness()
    stub(h.client, 'getContactById').mockResolvedValue({
      id: wid('b@c.us'),
      number: '1',
      isBusiness: true,
      isEnterprise: false,
      isGroup: false,
      isMe: false,
      isMyContact: false,
      isUser: true,
      isWAContact: true,
      isBlocked: false,
      pushname: 'Shop',
      sectionHeader: '',
      statusMute: false,
      type: 'in',
      businessProfile: undefined
    })
    ready(h)

    const dto = await h.adapter.getContactById('b@c.us')

    expect(dto).not.toHaveProperty('businessProfile')
    expect(dto.id).toBe('b@c.us')
  })

  it('keeps no more than 100 calls to reject', async () => {
    const h = harness()
    ready(h)
    const reject = jest.fn().mockResolvedValue(undefined)
    for (let index = 0; index < 101; index++) {
      h.client.emit('call', {
        id: `c${index}`,
        timestamp: 1,
        isVideo: false,
        isGroup: false,
        fromMe: false,
        canHandleLocally: false,
        webClientShouldHandle: false,
        reject
      })
    }

    await expect(h.adapter.rejectCall('c0')).rejects.toBeInstanceOf(WaOperationError)
    await expect(h.adapter.rejectCall('c100')).resolves.toBeUndefined()
  })

  it('lets wwebjs pause between membership requests unless the caller says otherwise', async () => {
    const h = harness()
    const approve = stub(h.client, 'approveGroupMembershipRequests').mockResolvedValue([])
    ready(h)

    await h.adapter.approveGroupMembershipRequests('g@g.us', {})
    await h.adapter.approveGroupMembershipRequests('g@g.us', { requesterIds: 'a@c.us', sleep: 5 })

    expect(approve.mock.calls[0]?.[1]).toEqual({ requesterIds: null, sleep: undefined })
    expect(approve.mock.calls[1]?.[1]).toEqual({ requesterIds: 'a@c.us', sleep: 5 })
  })

  it('passes the arguments of the argument-heavy calls in the right order', async () => {
    const h = harness()
    ready(h)
    const mute = stub(h.client, 'muteChat').mockResolvedValue({ isMuted: true, muteExpiration: 1 })
    const save = stub(h.client, 'saveOrEditAddressbookContact').mockResolvedValue(undefined)
    const unsubscribe = stub(h.client, 'unsubscribeFromChannel').mockResolvedValue(true)
    const invite = stub(h.client, 'sendChannelAdminInvite').mockResolvedValue(true)
    const transfer = stub(h.client, 'transferChannelOwnership').mockResolvedValue(true)
    const link = stub(h.client, 'createCallLink').mockResolvedValue('https://call.example/x')
    const until = new Date('2026-12-01T00:00:00Z')

    await h.adapter.muteChat('c@c.us', until)
    await h.adapter.saveOrEditAddressbookContact('5215500000001', 'Ana', 'Perez', true)
    await h.adapter.unsubscribeFromChannel('n@newsletter', { deleteLocalModels: true })
    await h.adapter.sendChannelAdminInvite('u@c.us', 'n@newsletter', { comment: 'join' })
    await h.adapter.transferChannelOwnership('n@newsletter', 'u@c.us', {
      shouldDismissSelfAsAdmin: true
    })
    await h.adapter.createCallLink(until, 'video')

    expect(mute).toHaveBeenCalledWith('c@c.us', until)
    expect(save).toHaveBeenCalledWith('5215500000001', 'Ana', 'Perez', true)
    expect(unsubscribe).toHaveBeenCalledWith('n@newsletter', { deleteLocalModels: true })
    expect(invite).toHaveBeenCalledWith('u@c.us', 'n@newsletter', { comment: 'join' })
    expect(transfer).toHaveBeenCalledWith('n@newsletter', 'u@c.us', {
      shouldDismissSelfAsAdmin: true
    })
    expect(link).toHaveBeenCalledWith(until, 'video')
  })

  it('builds a client from the factory with the session id in its auth strategy', () => {
    const adapter = createWwebjsClientFactory(config())('support-line', {})
    const client = (adapter as unknown as { client: { authStrategy: unknown } }).client

    expect(client.authStrategy).toMatchObject({ clientId: 'support-line' })
  })
})
