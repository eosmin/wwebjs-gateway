import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { FakeWhatsAppClient, buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import { parseEnv } from '../config/env.schema.js'
import type { MessagesRepository } from '../database/repositories/messages.repository.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { ChatDto, ChannelDto, MessageDto } from '../types/dto.js'

import { EventBusService } from './event-bus.service.js'
import type { EventPipelineService } from './event-pipeline.service.js'
import { ReconcilerService } from './reconciler.service.js'
import type { RunningSession, SessionManager } from './session-manager.service.js'

const ID = 'support-line'
const NOW = new Date('2026-10-28T12:00:00.000Z')
const nowSeconds = Math.floor(NOW.getTime() / 1000)
const agoHours = (hours: number): number => nowSeconds - hours * 3600

const chatOf = (id: string, overrides: Partial<ChatDto> = {}): ChatDto => ({
  id,
  archived: false,
  isGroup: false,
  isReadOnly: false,
  isMuted: false,
  muteExpiration: 0,
  name: id,
  timestamp: agoHours(1),
  unreadCount: 0,
  pinned: false,
  isLocked: false,
  ...overrides
})

const incoming = (id: string, chatId: string, hoursAgo = 1): MessageDto =>
  buildMessageDto({
    id,
    chatId,
    fromMe: false,
    sentAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString()
  })

function buildRun(overrides: Partial<RunningSession> = {}): RunningSession {
  return {
    id: ID,
    status: 'ready',
    generation: 1,
    client: new FakeWhatsAppClient(ID),
    phaseStartedAt: undefined,
    ...overrides
  }
}

interface Setup {
  chats?: (ChatDto | ChannelDto)[]
  history?: Record<string, MessageDto[]>
  stored?: string[]
  lastEventAt?: Date | null
  env?: Record<string, string>
  run?: RunningSession
}

function build(setup: Setup = {}) {
  const run = setup.run ?? buildRun()
  const client = run.client as FakeWhatsAppClient
  client.script('getChats', () => setup.chats ?? [])
  client.script('fetchMessages', (chatId: string) => setup.history?.[chatId] ?? [])
  const runs = [run]
  const manager = { running: jest.fn(() => runs) }
  const sessions = {
    findById: jest.fn(() => Promise.resolve({ lastEventAt: setup.lastEventAt ?? null }))
  }
  const messages = {
    findExistingIds: jest.fn((_session: string, ids: string[]) =>
      Promise.resolve(new Set(ids.filter(id => setup.stored?.includes(id))))
    )
  }
  const pipeline = {
    reconcile: jest.fn((_session: string, found: MessageDto[]) => Promise.resolve(found.length))
  }
  const bus = new EventBusService()
  const metrics = new MetricsService()
  const reconciler = new ReconcilerService(
    parseEnv({ ...TEST_ENV, ...setup.env }),
    bus,
    manager as unknown as SessionManager,
    sessions as unknown as SessionsRepository,
    messages as unknown as MessagesRepository,
    pipeline as unknown as EventPipelineService,
    metrics
  )
  return { reconciler, bus, client, run, runs, manager, sessions, messages, pipeline, metrics }
}

const idsSent = (pipeline: { reconcile: jest.Mock }): string[] =>
  (pipeline.reconcile.mock.calls as [string, MessageDto[]][]).flatMap(([, found]) =>
    found.map(message => message.id)
  )

let warnLog: jest.SpyInstance
let errorLog: jest.SpyInstance

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  jest.spyOn(Logger.prototype, 'log').mockImplementation()
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation()
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('ReconcilerService recovery', () => {
  it('feeds the incoming messages that are not stored to the pipeline', async () => {
    const { reconciler, pipeline, metrics } = build({
      chats: [chatOf('a@c.us', { unreadCount: 2 })],
      history: { 'a@c.us': [incoming('m1', 'a@c.us'), incoming('m2', 'a@c.us')] }
    })

    await expect(reconciler.reconcile(ID)).resolves.toBe(2)

    expect(pipeline.reconcile).toHaveBeenCalledWith(ID, [
      expect.objectContaining({ id: 'm1' }),
      expect.objectContaining({ id: 'm2' })
    ])
    expect(
      await metrics.registry.getSingleMetricAsString('gw_reconcile_recovered_total')
    ).toContain('gw_reconcile_recovered_total 2')
  })

  it('does not feed what is already stored', async () => {
    const { reconciler, pipeline } = build({
      chats: [chatOf('a@c.us', { unreadCount: 2 })],
      history: { 'a@c.us': [incoming('m1', 'a@c.us'), incoming('m2', 'a@c.us')] },
      stored: ['m1']
    })

    await reconciler.reconcile(ID)

    expect(idsSent(pipeline)).toEqual(['m2'])
  })

  it('does not call the pipeline when nothing is missing', async () => {
    const { reconciler, pipeline } = build({
      chats: [chatOf('a@c.us', { unreadCount: 1 })],
      history: { 'a@c.us': [incoming('m1', 'a@c.us')] },
      stored: ['m1']
    })

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(pipeline.reconcile).not.toHaveBeenCalled()
  })

  it('leaves out the messages of the account itself', async () => {
    const own = buildMessageDto({ id: 'mine', chatId: 'a@c.us', fromMe: true })
    const { reconciler, pipeline, messages } = build({
      chats: [chatOf('a@c.us', { unreadCount: 1 })],
      history: { 'a@c.us': [own, incoming('m1', 'a@c.us')] }
    })

    await reconciler.reconcile(ID)

    expect(idsSent(pipeline)).toEqual(['m1'])
    expect(messages.findExistingIds).toHaveBeenCalledWith(ID, ['m1'])
  })
})

describe('ReconcilerService lookback', () => {
  it('drops messages older than RECONCILE_LOOKBACK_HOURS', async () => {
    const { reconciler, pipeline } = build({
      chats: [chatOf('a@c.us', { unreadCount: 3 })],
      history: {
        'a@c.us': [incoming('old', 'a@c.us', 49), incoming('edge', 'a@c.us', 47)]
      }
    })

    await reconciler.reconcile(ID)

    expect(idsSent(pipeline)).toEqual(['edge'])
  })

  it('honors a shorter lookback', async () => {
    const { reconciler, pipeline } = build({
      chats: [chatOf('a@c.us', { unreadCount: 3 })],
      history: { 'a@c.us': [incoming('m1', 'a@c.us', 3), incoming('m2', 'a@c.us', 1)] },
      env: { RECONCILE_LOOKBACK_HOURS: '2' }
    })

    await reconciler.reconcile(ID)

    expect(idsSent(pipeline)).toEqual(['m2'])
  })

  it('does not even read a chat that has been quiet for longer than the lookback', async () => {
    const { reconciler, client } = build({
      chats: [chatOf('a@c.us', { unreadCount: 5, timestamp: agoHours(72) })]
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages')).toHaveLength(0)
  })
})

describe('ReconcilerService chat selection', () => {
  it('visits unread chats and chats newer than the last event, not the rest', async () => {
    const { reconciler, client } = build({
      chats: [
        chatOf('unread@c.us', { unreadCount: 1, timestamp: agoHours(10) }),
        chatOf('newer@c.us', { timestamp: agoHours(1) }),
        chatOf('seen@c.us', { timestamp: agoHours(10) })
      ],
      lastEventAt: new Date(NOW.getTime() - 5 * 3_600_000)
    })

    await reconciler.reconcile(ID)

    expect(
      client
        .callsOf('fetchMessages')
        .map(call => call.args[0])
        .sort()
    ).toEqual(['newer@c.us', 'unread@c.us'])
  })

  it('visits every active chat when no event is on record', async () => {
    const { reconciler, client } = build({
      chats: [chatOf('a@c.us'), chatOf('b@c.us')],
      lastEventAt: null
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages')).toHaveLength(2)
  })

  it('visits the most recent chats up to RECONCILE_MAX_CHATS', async () => {
    const { reconciler, client } = build({
      chats: [
        chatOf('old@c.us', { timestamp: agoHours(5) }),
        chatOf('new@c.us', { timestamp: agoHours(1) }),
        chatOf('mid@c.us', { timestamp: agoHours(3) })
      ],
      env: { RECONCILE_MAX_CHATS: '2' }
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages').map(call => call.args[0])).toEqual([
      'new@c.us',
      'mid@c.us'
    ])
  })

  // WhatsApp gives some chats no timestamp: their activity is unknown, so only unread ones are read
  it('reads a chat without a timestamp only when it has unread messages', async () => {
    const { reconciler, client } = build({
      chats: [
        chatOf('unread@c.us', { timestamp: null, unreadCount: 2 }),
        chatOf('read@c.us', { timestamp: null })
      ]
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages').map(call => call.args[0])).toEqual(['unread@c.us'])
  })

  it('keeps an unread chat without a timestamp when the cap cuts', async () => {
    const { reconciler, client } = build({
      chats: [
        chatOf('undated@c.us', { timestamp: null, unreadCount: 1 }),
        chatOf('old@c.us', { timestamp: agoHours(5) }),
        chatOf('new@c.us', { timestamp: agoHours(1) })
      ],
      env: { RECONCILE_MAX_CHATS: '2' },
      lastEventAt: null
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages').map(call => call.args[0])).toEqual([
      'undated@c.us',
      'new@c.us'
    ])
  })

  it('asks for RECONCILE_FETCH_LIMIT messages per chat', async () => {
    const { reconciler, client } = build({
      chats: [chatOf('a@c.us')],
      env: { RECONCILE_FETCH_LIMIT: '20' }
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages')[0]?.args).toEqual(['a@c.us', { limit: 20 }])
  })

  it('skips channels', async () => {
    const channel: ChannelDto = {
      id: 'news@newsletter',
      name: 'news',
      description: '',
      isChannel: true,
      isGroup: false,
      isReadOnly: true,
      unreadCount: 4,
      timestamp: agoHours(1),
      isMuted: false,
      muteExpiration: 0
    }
    const { reconciler, client } = build({ chats: [channel] })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages')).toHaveLength(0)
  })
})

describe('ReconcilerService boundaries', () => {
  it('keeps a message sent exactly at the start of the lookback', async () => {
    const { reconciler, pipeline } = build({
      chats: [chatOf('a@c.us', { unreadCount: 1 })],
      history: { 'a@c.us': [incoming('edge', 'a@c.us', 48), incoming('late', 'a@c.us', 48.001)] }
    })

    await reconciler.reconcile(ID)

    expect(idsSent(pipeline)).toEqual(['edge'])
  })

  it('visits a chat active exactly at the start of the lookback', async () => {
    const { reconciler, client } = build({
      chats: [chatOf('a@c.us', { timestamp: agoHours(48) })]
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages')).toHaveLength(1)
  })

  it('skips a read chat whose last activity is exactly the last event', async () => {
    const { reconciler, client } = build({
      chats: [chatOf('a@c.us', { timestamp: agoHours(5) })],
      lastEventAt: new Date(agoHours(5) * 1000)
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages')).toHaveLength(0)
  })

  it('applies RECONCILE_MAX_CHATS to the candidates, not to every chat', async () => {
    const { reconciler, client } = build({
      chats: [
        chatOf('seen1@c.us', { timestamp: agoHours(1) }),
        chatOf('seen2@c.us', { timestamp: agoHours(2) }),
        chatOf('unread1@c.us', { unreadCount: 1, timestamp: agoHours(10) }),
        chatOf('unread2@c.us', { unreadCount: 1, timestamp: agoHours(11) }),
        chatOf('unread3@c.us', { unreadCount: 1, timestamp: agoHours(12) })
      ],
      lastEventAt: new Date(NOW.getTime() - 1_800_000),
      env: { RECONCILE_MAX_CHATS: '2' }
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages').map(call => call.args[0])).toEqual([
      'unread1@c.us',
      'unread2@c.us'
    ])
  })
})

describe('ReconcilerService switches', () => {
  it.each([
    ['RECONCILE_ON_READY', 'false'],
    ['RECONCILE_MAX_CHATS', '0'],
    ['RECONCILE_LOOKBACK_HOURS', '0']
  ])('does nothing with %s=%s', async (name, value) => {
    const { reconciler, client } = build({ chats: [chatOf('a@c.us')], env: { [name]: value } })

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(client.callsOf('getChats')).toHaveLength(0)
  })

  it('does nothing once the application is shutting down', async () => {
    const { reconciler, client } = build({ chats: [chatOf('a@c.us')] })
    reconciler.beforeApplicationShutdown()

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(client.callsOf('getChats')).toHaveLength(0)
  })

  it('does nothing for a session that is not ready', async () => {
    const { reconciler, client } = build({
      chats: [chatOf('a@c.us')],
      run: buildRun({ status: 'starting' })
    })

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(client.callsOf('getChats')).toHaveLength(0)
  })

  it('does nothing for a session the manager does not run', async () => {
    const { reconciler, runs, client } = build({ chats: [chatOf('a@c.us')] })
    runs.length = 0

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(client.callsOf('getChats')).toHaveLength(0)
  })
})

describe('ReconcilerService failures and stale runs', () => {
  it('goes on with the next chat when one fails', async () => {
    const { reconciler, client, pipeline } = build({
      chats: [
        chatOf('bad@c.us', { timestamp: agoHours(1) }),
        chatOf('good@c.us', { timestamp: agoHours(2) })
      ]
    })
    client.script('fetchMessages', (chatId: string) => {
      if (chatId === 'bad@c.us') throw new Error('page crashed')
      return [incoming('m1', 'good@c.us')]
    })

    await expect(reconciler.reconcile(ID)).resolves.toBe(1)
    expect(idsSent(pipeline)).toEqual(['m1'])
    expect(warnLog).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the chat list cannot be read', async () => {
    const { reconciler, client } = build()
    client.script('getChats', () => {
      throw new Error('page crashed')
    })

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
  })

  it('stops when the run it started on is over', async () => {
    const { reconciler, client, runs, run } = build({
      chats: [
        chatOf('a@c.us', { timestamp: agoHours(1) }),
        chatOf('b@c.us', { timestamp: agoHours(2) })
      ]
    })
    client.script('fetchMessages', () => {
      runs[0] = { ...run, generation: 2 }
      return [incoming('m1', 'a@c.us')]
    })

    await reconciler.reconcile(ID)

    expect(client.callsOf('fetchMessages')).toHaveLength(1)
  })

  it('does not hand the pipeline what it read for a run that ended meanwhile', async () => {
    const { reconciler, client, runs, run, pipeline } = build({ chats: [chatOf('a@c.us')] })
    client.script('fetchMessages', () => {
      runs[0] = { ...run, status: 'disconnected' }
      return [incoming('m1', 'a@c.us')]
    })

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(pipeline.reconcile).not.toHaveBeenCalled()
  })
})

describe('ReconcilerService timeouts and errors', () => {
  const twoChats = [
    chatOf('slow@c.us', { timestamp: agoHours(1) }),
    chatOf('good@c.us', { timestamp: agoHours(2) })
  ]

  it('gives up on a chat list that never answers', async () => {
    const { reconciler, client } = build()
    client.script('getChats', () => new Promise(() => undefined))

    const pass = reconciler.reconcile(ID)
    await jest.advanceTimersByTimeAsync(60_000)

    await expect(pass).resolves.toBe(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
  })

  it('gives up on a chat that never answers and goes on with the next', async () => {
    const { reconciler, client, pipeline } = build({ chats: twoChats })
    client.script('fetchMessages', (chatId: string) =>
      chatId === 'slow@c.us' ? new Promise(() => undefined) : [incoming('m1', 'good@c.us')]
    )

    const pass = reconciler.reconcile(ID)
    await jest.advanceTimersByTimeAsync(15_000)

    await expect(pass).resolves.toBe(1)
    expect(idsSent(pipeline)).toEqual(['m1'])
    expect(warnLog).toHaveBeenCalledTimes(1)
  })

  it('goes on with the next chat when the stored ids cannot be read', async () => {
    const { reconciler, client, messages, pipeline } = build({ chats: twoChats })
    client.script('fetchMessages', (chatId: string) => [incoming(`m-${chatId}`, chatId)])
    messages.findExistingIds.mockRejectedValueOnce(new Error('db down'))

    await expect(reconciler.reconcile(ID)).resolves.toBe(1)
    expect(idsSent(pipeline)).toEqual(['m-good@c.us'])
    expect(warnLog).toHaveBeenCalledTimes(1)
  })

  it('goes on with the next chat when the pipeline rejects', async () => {
    const { reconciler, client, pipeline } = build({ chats: twoChats })
    client.script('fetchMessages', (chatId: string) => [incoming(`m-${chatId}`, chatId)])
    pipeline.reconcile.mockRejectedValueOnce(new Error('boom'))

    await expect(reconciler.reconcile(ID)).resolves.toBe(1)
    expect(warnLog).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the session row cannot be read, and can run again after', async () => {
    const { reconciler, client, sessions } = build({ chats: [chatOf('a@c.us')] })
    sessions.findById.mockRejectedValueOnce(new Error('db down'))

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(client.callsOf('getChats')).toHaveLength(0)

    await reconciler.reconcile(ID)
    expect(client.callsOf('getChats')).toHaveLength(1)
  })

  it('stops the pass at shutdown and hands nothing to the pipeline', async () => {
    const { reconciler, client, pipeline } = build({ chats: twoChats })
    client.script('fetchMessages', () => {
      reconciler.beforeApplicationShutdown()
      return [incoming('m1', 'slow@c.us')]
    })

    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    expect(client.callsOf('fetchMessages')).toHaveLength(1)
    expect(pipeline.reconcile).not.toHaveBeenCalled()
  })
})

describe('ReconcilerService concurrency', () => {
  it('does not start a second pass for a run that already has one', async () => {
    const { reconciler, client } = build({ chats: [chatOf('a@c.us')] })
    let release: () => void = () => undefined
    client.script(
      'getChats',
      () =>
        new Promise(resolve => {
          release = () => resolve([chatOf('a@c.us')])
        })
    )

    const first = reconciler.reconcile(ID)
    await jest.advanceTimersByTimeAsync(0)
    await expect(reconciler.reconcile(ID)).resolves.toBe(0)
    release()
    await first

    expect(client.callsOf('getChats')).toHaveLength(1)
  })

  it('lets a new run reconcile while the pass of the old one winds down', async () => {
    const { reconciler, client, runs, run } = build({ chats: [chatOf('a@c.us')] })
    const releases: (() => void)[] = []
    client.script(
      'getChats',
      () =>
        new Promise(resolve => {
          releases.push(() => resolve([]))
        })
    )
    const first = reconciler.reconcile(ID)
    await jest.advanceTimersByTimeAsync(0)
    runs[0] = { ...run, generation: 2 }

    const second = reconciler.reconcile(ID)
    await jest.advanceTimersByTimeAsync(0)
    expect(client.callsOf('getChats')).toHaveLength(2)

    releases.forEach(release => release())
    await Promise.all([first, second])
  })

  it('keeps the marker of the new run when the old pass ends', async () => {
    const { reconciler, client, runs, run } = build({ chats: [chatOf('a@c.us')] })
    const releases: (() => void)[] = []
    client.script(
      'getChats',
      () =>
        new Promise(resolve => {
          releases.push(() => resolve([]))
        })
    )
    const first = reconciler.reconcile(ID)
    await jest.advanceTimersByTimeAsync(0)
    runs[0] = { ...run, generation: 2 }
    const second = reconciler.reconcile(ID)
    await jest.advanceTimersByTimeAsync(0)

    releases[0]?.()
    await first
    await expect(reconciler.reconcile(ID)).resolves.toBe(0)

    expect(client.callsOf('getChats')).toHaveLength(2)
    releases[1]?.()
    await second
  })

  it('can reconcile again once the pass is over', async () => {
    const { reconciler, client } = build({ chats: [chatOf('a@c.us')] })

    await reconciler.reconcile(ID)
    await reconciler.reconcile(ID)

    expect(client.callsOf('getChats')).toHaveLength(2)
  })
})

describe('ReconcilerService on session_status', () => {
  const publishStatus = (bus: EventBusService, status: 'ready' | 'qr'): void => {
    bus.publish({
      id: 'e1',
      event: 'session_status',
      sessionId: ID,
      seq: 1,
      timestamp: NOW.toISOString(),
      data: { status, previous: 'starting' }
    })
  }

  it('reconciles when the session becomes ready', async () => {
    const { reconciler, bus, client } = build({ chats: [chatOf('a@c.us')] })
    reconciler.onApplicationBootstrap()

    publishStatus(bus, 'qr')
    publishStatus(bus, 'ready')
    await jest.advanceTimersByTimeAsync(0)

    expect(client.callsOf('getChats')).toHaveLength(1)
  })

  it('stops listening and working at shutdown', async () => {
    const { reconciler, bus, client } = build({ chats: [chatOf('a@c.us')] })
    reconciler.onApplicationBootstrap()
    reconciler.beforeApplicationShutdown()

    publishStatus(bus, 'ready')
    await jest.advanceTimersByTimeAsync(0)

    expect(client.callsOf('getChats')).toHaveLength(0)
  })
})
