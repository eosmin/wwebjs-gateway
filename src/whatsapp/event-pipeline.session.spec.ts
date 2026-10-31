import { Logger } from '@nestjs/common'

import { FakeWhatsAppClient, buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import type { StoredMessage } from '../database/models.js'
import type { NewStoredMessage } from '../database/repositories/messages.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { MessageDto } from '../types/dto.js'
import type { EventEnvelope } from '../types/events.js'

import { EventSequencer } from './event-pipeline.sequencer.js'
import {
  SessionEventPipeline,
  type PipelineMessages,
  type SessionPipelineOptions
} from './event-pipeline.session.js'
import type { ClientEvent } from './whatsapp-client.port.js'

const SESSION = 'support-line'
const CHAT = '5215500000001@c.us'
const OTHER_CHAT = '5215500000002@c.us'
const NOW = new Date('2026-10-27T12:00:00.000Z')

const OPTIONS: SessionPipelineOptions = {
  sessionId: SESSION,
  orderingEnabled: true,
  order: { lateThresholdS: 3, windowMs: 1500, maxHoldMs: 5000, maxMessages: 200 },
  storeBodies: true,
  replayDelayMs: 5000,
  maxReplayDelayMs: 60_000,
  fetchTimeoutMs: 10_000,
  policyTimeoutMs: 2000
}

type Row = StoredMessage

// The messages table, in memory, with the semantics of the repository
class MemoryMessages implements PipelineMessages {
  readonly rows = new Map<string, Row>()
  failUpsert = false
  upsertError = new Error('db down')

  upsert(message: NewStoredMessage): Promise<Row> {
    if (this.failUpsert) return Promise.reject(this.upsertError)
    let row = this.rows.get(message.id)
    if (!row) {
      row = {
        ...message,
        origin: message.origin ?? null,
        emittedAt: null,
        policyHandledAt: null,
        policyText: message.policyText ?? null,
        createdAt: new Date()
      } as unknown as Row
      this.rows.set(message.id, row)
    }
    return Promise.resolve(row)
  }

  updateAck(_sessionId: string, id: string, ack: number): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || (row.ack !== null && row.ack >= ack)) return Promise.resolve(false)
    row.ack = ack
    return Promise.resolve(true)
  }

  markEmitted(_sessionId: string, ids: string[], at: Date): Promise<number> {
    let count = 0
    for (const id of ids) {
      const row = this.rows.get(id)
      if (row && row.emittedAt === null) {
        row.emittedAt = at
        count += 1
      }
    }
    return Promise.resolve(count)
  }

  markPolicyHandled(_sessionId: string, ids: string[], at: Date): Promise<number> {
    let count = 0
    for (const id of ids) {
      const row = this.rows.get(id)
      if (row && row.policyHandledAt === null) {
        row.policyHandledAt = at
        row.policyText = null
        count += 1
      }
    }
    return Promise.resolve(count)
  }

  listPolicyPending(): Promise<Row[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(row => row.direction === 'in' && row.policyHandledAt === null)
        .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    )
  }

  listUnemitted(_sessionId: string, chatId?: string): Promise<Row[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          row =>
            row.direction === 'in' &&
            row.emittedAt === null &&
            (chatId === undefined || row.chatId === chatId)
        )
        .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    )
  }
}

interface Env {
  messages: MemoryMessages
  published: EventEnvelope[]
  seen: Set<string>
  counter: { seq: number }
  client: FakeWhatsAppClient
  metrics: MetricsService
  nextSeq: jest.Mock<Promise<number>, [string]>
  claim: jest.Mock<Promise<boolean>, [string]>
  unclaim: jest.Mock<Promise<void>, [string]>
  noteIncoming: jest.Mock<void, [Date]>
  handleIncoming: jest.Mock<Promise<boolean>, [string, string]>
}

// The database and Redis (the dedupe keys and the seq counter) outlive a pipeline, as they outlive
// a crashed process: the environment of a restart takes them from the one that crashed
function environment(previous?: Env): Env {
  const published: EventEnvelope[] = []
  const seen = previous?.seen ?? new Set<string>()
  const counter = previous?.counter ?? { seq: 0 }
  return {
    messages: previous?.messages ?? new MemoryMessages(),
    published,
    seen,
    counter,
    client: new FakeWhatsAppClient(SESSION),
    metrics: new MetricsService(),
    nextSeq: jest.fn((_sessionId: string) => Promise.resolve(++counter.seq)),
    claim: jest.fn(key => Promise.resolve(!seen.has(key) && Boolean(seen.add(key)))),
    noteIncoming: jest.fn<void, [Date]>(),
    handleIncoming: jest.fn((_chatId: string, _text: string) => Promise.resolve(false)),
    unclaim: jest.fn((key: string) => {
      seen.delete(key)
      return Promise.resolve()
    })
  }
}

function start(env: Env, options: Partial<SessionPipelineOptions> = {}): SessionEventPipeline {
  const sequencer = new EventSequencer({
    nextSeq: sessionId => env.nextSeq(sessionId),
    publish: envelope => env.published.push(envelope)
  })
  const pipeline = new SessionEventPipeline(
    { ...OPTIONS, ...options },
    {
      client: env.client,
      messages: env.messages,
      sequencer,
      claim: key => env.claim(key),
      unclaim: key => env.unclaim(key),
      noteIncoming: at => env.noteIncoming(at),
      handleIncoming: (chatId, text) => env.handleIncoming(chatId, text),
      metrics: env.metrics.metrics
    }
  )
  pipeline.start()
  return pipeline
}

// A message the sender wrote `writtenAgoS` seconds before the gateway got it (now)
function incoming(
  id: string,
  writtenAgoS: number,
  overrides: Partial<MessageDto> = {}
): MessageDto {
  return buildMessageDto({
    id,
    chatId: CHAT,
    fromMe: false,
    from: CHAT,
    body: `text of ${id}`,
    sentAt: new Date(Date.now() - writtenAgoS * 1000).toISOString(),
    receivedAt: new Date().toISOString(),
    ...overrides
  })
}

const message = (data: MessageDto): ClientEvent => ({ event: 'message', data })
const created = (data: MessageDto): ClientEvent => ({ event: 'message_create', data })
const ack = (data: MessageDto, level: number): ClientEvent => ({
  event: 'message_ack',
  data: { message: data, ack: level }
})

const advance = (ms: number): Promise<void> => jest.advanceTimersByTimeAsync(ms)

const names = (env: Env): string[] =>
  env.published.map(envelope => {
    const data = envelope.data as { id?: string; message?: { id: string } }
    return `${envelope.event}:${data.id ?? data.message?.id ?? ''}`
  })

const seqs = (env: Env): number[] => env.published.map(envelope => envelope.seq)

const countOf = (env: Env, stage: string): Promise<number> =>
  env.metrics.registry
    .getSingleMetricAsString('gw_pipeline_errors_total')
    .then(text => Number(new RegExp(`stage="${stage}"\\} (\\d+)`).exec(text)?.[1] ?? 0))

let errorLog: jest.SpyInstance
let pipelines: SessionEventPipeline[]
// Timers the metrics registry keeps; the pipeline's own are the ones above it
let baseTimers = 0
const pipelineTimers = (): number => jest.getTimerCount() - baseTimers

function open(env: Env, options: Partial<SessionPipelineOptions> = {}): SessionEventPipeline {
  baseTimers = jest.getTimerCount()
  const pipeline = start(env, options)
  pipelines.push(pipeline)
  return pipeline
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation()
  pipelines = []
})

afterEach(async () => {
  await Promise.all(pipelines.map(pipeline => pipeline.close()))
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('SessionEventPipeline', () => {
  describe('publishing', () => {
    it('publishes a message that is not late at once, stores it and marks it as emitted', async () => {
      const env = environment()
      open(env)

      env.client.emit(message(incoming('a', 1)))
      await advance(0)

      expect(names(env)).toEqual(['message:a'])
      expect(env.published[0]?.data).not.toHaveProperty('ordering')
      expect(env.messages.rows.get('a')?.emittedAt).toEqual(NOW)
    })

    it('lets the events that carry no message straight through, in order', async () => {
      const env = environment()
      open(env)

      env.client.emit({ event: 'authenticated', data: {} })
      env.client.emit({ event: 'ready', data: {} })
      env.client.emit({ event: 'change_state', data: { state: 'CONNECTED' } })
      await advance(0)

      expect(env.published.map(envelope => envelope.event)).toEqual([
        'authenticated',
        'ready',
        'change_state'
      ])
      expect(seqs(env)).toEqual([1, 2, 3])
    })

    it('counts every event it receives', async () => {
      const env = environment()
      open(env)

      env.client.emit({ event: 'ready', data: {} })
      env.client.emit(message(incoming('a', 0)))
      await advance(0)

      const body = await env.metrics.scrape()
      expect(body).toContain('gw_events_total{event="ready"} 1')
      expect(body).toContain('gw_events_total{event="message"} 1')
    })

    it('counts an event the adapter could not map, until it is closed', async () => {
      const env = environment()
      const pipeline = open(env)

      env.client.skip('message')
      await pipeline.close()
      env.client.skip('message')

      expect(await env.metrics.scrape()).toContain('gw_events_skipped_total{event="message"} 1')
    })

    it('stops listening and ignores events once closed', async () => {
      const env = environment()
      const pipeline = open(env)

      await pipeline.close()
      env.client.emit(message(incoming('a', 0)))
      await advance(0)

      expect(env.client.listenerCount).toBe(0)
      expect(env.published).toEqual([])
      expect(env.messages.rows.size).toBe(0)
    })

    it('closes twice without harm', async () => {
      const env = environment()
      const pipeline = open(env)

      await pipeline.close()

      await expect(pipeline.close()).resolves.toBeUndefined()
    })
  })

  describe('dedupe', () => {
    it('drops a message the client emits twice', async () => {
      const env = environment()
      open(env)

      env.client.emit(message(incoming('a', 0)))
      env.client.emit(message(incoming('a', 0)))
      await advance(0)

      expect(names(env)).toEqual(['message:a'])
      expect(env.claim).toHaveBeenCalledWith(`dedupe:${SESSION}:message:a`)
    })

    it('treats message and message_create of one message as two events', async () => {
      const env = environment()
      open(env)

      env.client.emit(created(incoming('a', 0)))
      env.client.emit(message(incoming('a', 0)))
      await advance(0)

      expect(names(env)).toEqual(['message_create:a', 'message:a'])
    })

    it('dedupes message_ack on the message and the ack', async () => {
      const env = environment()
      open(env)
      const sent = incoming('a', 0, { fromMe: true })

      env.client.emit(ack(sent, 2))
      env.client.emit(ack(sent, 2))
      env.client.emit(ack(sent, 3))
      await advance(0)

      expect(env.published.map(envelope => envelope.event)).toEqual(['message_ack', 'message_ack'])
    })

    it('does not dedupe the events without a message', async () => {
      const env = environment()
      open(env)

      env.client.emit({ event: 'ready', data: {} })
      env.client.emit({ event: 'ready', data: {} })
      await advance(0)

      expect(env.published).toHaveLength(2)
      expect(env.claim).not.toHaveBeenCalled()
    })

    it('goes on, and counts it, when Redis cannot answer', async () => {
      const env = environment()
      env.claim.mockRejectedValue(new Error('redis down'))
      open(env)

      env.client.emit(message(incoming('a', 0)))
      await advance(0)

      expect(names(env)).toEqual(['message:a'])
      expect(await countOf(env, 'dedupe')).toBe(1)
    })
  })

  describe('store', () => {
    it('keeps the body only when the gateway is set to store bodies', async () => {
      const env = environment()
      open(env, { storeBodies: false })

      env.client.emit(message(incoming('a', 0)))
      await advance(0)

      expect(env.messages.rows.get('a')?.body).toBeNull()
      expect(JSON.stringify(env.messages.rows.get('a')?.dto)).not.toContain('text of a')
      // The event itself still carries the text
      expect((env.published[0]?.data as MessageDto).body).toBe('text of a')
    })

    it('does not block the stream when the store fails', async () => {
      const env = environment()
      env.messages.failUpsert = true
      open(env)

      env.client.emit(message(incoming('a', 0)))
      await advance(0)

      expect(names(env)).toEqual(['message:a'])
      expect(await countOf(env, 'store')).toBe(1)
    })

    it('moves the stored ack forward with message_ack, and never creates a row from it', async () => {
      const env = environment()
      open(env)
      const sent = incoming('a', 0, { fromMe: true, ack: 1 })
      env.client.emit(created(sent))
      env.client.emit(ack(sent, 3))
      env.client.emit(ack(incoming('stranger', 0, { fromMe: false }), 3))
      await advance(0)

      expect(env.messages.rows.get('a')?.ack).toBe(3)
      expect(env.messages.rows.has('stranger')).toBe(false)
    })

    it('logs a failure with the error class only, never the message text', async () => {
      const env = environment()
      env.messages.failUpsert = true
      open(env)

      env.client.emit(message(incoming('a', 0, { body: 'top secret' })))
      await advance(0)

      const logged = (errorLog.mock.calls as unknown[][]).flat().join(' ')
      expect(logged).toContain('store failed')
      expect(logged).not.toContain('top secret')
      expect(logged).not.toContain('db down')
    })

    it('names the arguments Prisma refused, never their values', async () => {
      const env = environment()
      env.messages.failUpsert = true
      env.messages.upsertError = Object.assign(
        new Error(
          'Invalid `prisma.storedMessage.upsert()` invocation:\n{ body: "top secret" }\n' +
            'Argument `hasMedia` is missing.\n' +
            'Invalid value for argument `sentAt`: Provided Date object is invalid.\n' +
            'argument `leakedWord` was in the text'
        ),
        { name: 'PrismaClientValidationError' }
      )
      open(env)

      env.client.emit(message(incoming('a', 0, { body: 'top secret' })))
      await advance(0)

      const logged = (errorLog.mock.calls as unknown[][]).flat().join(' ')
      expect(logged).toContain('PrismaClientValidationError')
      expect(logged).toContain('hasMedia, sentAt')
      expect(logged).not.toContain('top secret')
      expect(logged).not.toContain('leakedWord')
    })
  })

  describe('order', () => {
    it('publishes a burst sorted by sentAt, with consecutive seq, flags and a batch', async () => {
      const env = environment()
      open(env)

      env.client.emit(message(incoming('third', 10)))
      env.client.emit(message(incoming('first', 30)))
      env.client.emit(message(incoming('second', 20)))
      await advance(0)
      expect(env.published).toEqual([])

      await advance(OPTIONS.order.windowMs)

      expect(names(env)).toEqual([
        'message:first',
        'message:second',
        'message:third',
        'message_batch:'
      ])
      expect(seqs(env)).toEqual([1, 2, 3, 4])
      const data = env.published.slice(0, 3).map(envelope => (envelope.data as MessageDto).ordering)
      expect(data.map(ordering => ordering?.held)).toEqual([true, true, true])
      expect(data.map(ordering => ordering?.reordered)).toEqual([true, true, true])
      expect(env.published[3]?.data).toMatchObject({ chatId: CHAT, count: 3, reason: 'burst' })
      expect([...env.messages.rows.values()].every(row => row.emittedAt !== null)).toBe(true)
    })

    it('counts the held messages in the metrics', async () => {
      const env = environment()
      open(env)

      env.client.emit(message(incoming('b', 10)))
      env.client.emit(message(incoming('a', 20)))
      await advance(OPTIONS.order.windowMs)

      const body = await env.metrics.scrape()
      expect(body).toContain('gw_ordering_held_total 2')
      expect(body).toContain('gw_ordering_reordered_total 2')
      expect(body).toContain('gw_ordering_hold_seconds_count 2')
    })

    it('uses the order WhatsApp Web shows to break a tie in the same second', async () => {
      const env = environment()
      const sentAt = new Date(Date.now() - 10_000).toISOString()
      const x = incoming('x', 10, { sentAt })
      const y = incoming('y', 10, { sentAt })
      env.client.script('fetchMessages', () => [y, x])
      open(env)

      env.client.emit(message(x))
      env.client.emit(message(y))
      await advance(OPTIONS.order.windowMs)

      expect(names(env).slice(0, 2)).toEqual(['message:y', 'message:x'])
      expect(env.client.callsOf('fetchMessages')[0]?.args).toEqual([CHAT, { limit: 7 }])
    })

    it('does not wait forever for a fetch that never settles', async () => {
      const env = environment()
      env.client.script('fetchMessages', () => new Promise<MessageDto[]>(() => undefined))
      open(env)

      env.client.emit(message(incoming('a', 10)))
      await advance(OPTIONS.order.windowMs + OPTIONS.fetchTimeoutMs)

      expect(names(env)).toEqual(['message:a'])
    })

    it('holds a message that arrives while the chat has a buffer open, to keep the order', async () => {
      const env = environment()
      open(env)

      env.client.emit(message(incoming('old', 10)))
      env.client.emit(message(incoming('live', 0)))
      await advance(OPTIONS.order.windowMs)

      expect(names(env).slice(0, 2)).toEqual(['message:old', 'message:live'])
    })

    it('does not let an event without a message overtake a batch being published', async () => {
      const env = environment()
      // The stamp of every event takes 100 ms
      let seq = 0
      env.nextSeq.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(++seq), 100))
      )
      open(env)

      env.client.emit(message(incoming('b', 10)))
      env.client.emit(message(incoming('a', 20)))
      await advance(OPTIONS.order.windowMs + 50)
      env.client.emit({ event: 'change_state', data: { state: 'CONNECTED' } })
      await advance(2000)

      expect(names(env)).toEqual(['message:a', 'message:b', 'message_batch:', 'change_state:'])
      expect(seqs(env)).toEqual([1, 2, 3, 4])
    })

    it('keeps seq strictly increasing across chats and direct events', async () => {
      const env = environment()
      open(env)

      env.client.emit(message(incoming('late', 10)))
      env.client.emit(message(incoming('other', 0, { chatId: OTHER_CHAT })))
      env.client.emit({ event: 'ready', data: {} })
      env.client.emit(message(incoming('late2', 9)))
      await advance(OPTIONS.order.windowMs)
      env.client.emit(message(incoming('after', 0)))
      await advance(0)

      expect(names(env)).toEqual([
        'message:other',
        'ready:',
        'message:late',
        'message:late2',
        'message_batch:',
        'message:after'
      ])
      expect(seqs(env)).toEqual([1, 2, 3, 4, 5, 6])
    })

    it('publishes late messages as they come when ordering is off', async () => {
      const env = environment()
      open(env, { orderingEnabled: false })

      env.client.emit(message(incoming('b', 10)))
      env.client.emit(message(incoming('a', 20)))
      await advance(0)

      expect(names(env)).toEqual(['message:b', 'message:a'])
      expect(env.client.callsOf('fetchMessages')).toEqual([])
    })
  })

  describe('events about a held message', () => {
    it('publishes an ack, an edit, a reaction and a revoke right behind the message', async () => {
      const env = environment()
      open(env)
      const held = incoming('held', 10)

      env.client.emit(message(held))
      env.client.emit(ack(held, 3))
      env.client.emit({
        event: 'message_edit',
        data: { message: held, newBody: 'b', prevBody: 'a' }
      })
      env.client.emit({
        event: 'message_reaction',
        data: {
          id: 'r1',
          orphan: 0,
          timestamp: 1,
          reaction: '👍',
          read: false,
          msgId: 'held',
          senderId: CHAT
        }
      })
      env.client.emit({ event: 'message_revoke_everyone', data: { message: held } })
      env.client.emit({ event: 'message_revoke_me', data: held })
      await advance(0)
      expect(env.published).toEqual([])
      await advance(OPTIONS.order.windowMs)

      expect(env.published.map(envelope => envelope.event)).toEqual([
        'message',
        'message_ack',
        'message_edit',
        'message_reaction',
        'message_revoke_everyone',
        'message_revoke_me'
      ])
    })

    it('publishes the twin event of a held message behind it', async () => {
      const env = environment()
      open(env)
      const held = incoming('held', 10)

      env.client.emit(created(held))
      env.client.emit(message(held))
      await advance(OPTIONS.order.windowMs)

      expect(names(env)).toEqual(['message_create:held', 'message:held'])
    })

    it('publishes the events of a message that is not held without waiting', async () => {
      const env = environment()
      open(env)
      const sent = incoming('a', 0, { fromMe: true })

      env.client.emit(created(sent))
      env.client.emit(ack(sent, 2))
      await advance(0)

      expect(env.published.map(envelope => envelope.event)).toEqual([
        'message_create',
        'message_ack'
      ])
    })

    it('drops an event about a held message that fails to publish, and counts it', async () => {
      const env = environment()
      open(env)
      const held = incoming('held', 10)
      env.client.emit(message(held))
      env.client.emit(ack(held, 3))
      await advance(0)
      // Stamps: the message gets 1; the ack fails
      env.nextSeq.mockImplementationOnce(() => Promise.resolve(1))
      env.nextSeq.mockImplementationOnce(() => Promise.reject(new Error('redis down')))
      await advance(OPTIONS.order.windowMs)

      expect(names(env)).toEqual(['message:held'])
      expect(await countOf(env, 'publish')).toBe(1)
      expect(env.messages.rows.get('held')?.emittedAt).not.toBeNull()
    })
  })

  describe('events that arrive while a batch is being published', () => {
    it('publishes an ack that attaches to a message while its batch goes out, right behind it', async () => {
      const env = environment()
      let seq = 0
      env.nextSeq.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(++seq), 100))
      )
      open(env)
      const held = incoming('held', 10)

      env.client.emit(message(held))
      await advance(OPTIONS.order.windowMs + 50)
      // The message is out of the buffer's snapshot but its batch is still being published
      env.client.emit(ack(held, 3))
      await advance(2000)

      expect(names(env)).toEqual(['message:held', 'message_ack:held'])
      expect(seqs(env)).toEqual([1, 2])
    })
  })

  describe('closing while work is queued', () => {
    // The first stamp waits, so what comes after it is still queued when the pipeline closes
    function blockFirstStamp(env: Env): () => void {
      let release: () => void = () => undefined
      env.nextSeq.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = () => resolve(1)
          })
      )
      return () => release()
    }

    it('does not publish a direct event queued behind the stamp that was running', async () => {
      const env = environment()
      const unblock = blockFirstStamp(env)
      const pipeline = open(env)
      env.client.emit({ event: 'change_state', data: { state: 'CONNECTED' } })
      env.client.emit(message(incoming('queued', 0)))
      await advance(0)

      const closing = pipeline.close()
      unblock()
      await closing

      expect(env.published.map(envelope => envelope.event)).toEqual(['change_state'])
      expect(env.messages.rows.get('queued')?.emittedAt).toBeNull()
    })

    it('does not publish a batch queued behind the stamp that was running', async () => {
      const env = environment()
      const unblock = blockFirstStamp(env)
      const pipeline = open(env)
      env.client.emit({ event: 'change_state', data: { state: 'CONNECTED' } })
      env.client.emit(message(incoming('held', 10)))
      await advance(OPTIONS.order.windowMs)

      const closing = pipeline.close()
      unblock()
      await closing

      expect(env.published.map(envelope => envelope.event)).toEqual(['change_state'])
      expect(env.messages.rows.get('held')?.emittedAt).toBeNull()
    })

    it('drops an event that was accepted but not yet handled', async () => {
      const env = environment()
      const pipeline = open(env)

      env.client.emit(message(incoming('a', 0)))
      await pipeline.close()
      await advance(0)

      expect(env.published).toEqual([])
      expect(env.messages.rows.size).toBe(0)
    })
  })

  describe('crash recovery', () => {
    it('publishes in order, on the next ready, what a crashed process held', async () => {
      const env = environment()
      const crashed = open(env)
      env.client.emit({ event: 'authenticated', data: {} })
      env.client.emit(message(incoming('third', 10)))
      env.client.emit(message(incoming('first', 30)))
      env.client.emit(message(incoming('second', 20)))
      await advance(0)
      // The process dies while the buffer holds them: nothing was published, everything is stored
      await crashed.close()
      expect(names(env)).toEqual(['authenticated:'])
      expect([...env.messages.rows.values()].map(row => row.emittedAt)).toEqual([null, null, null])

      const restarted = environment(env)
      open(restarted)
      restarted.client.emit({ event: 'ready', data: {} })
      // WhatsApp delivers one of them again: Redis still remembers it, so only the database sends it
      restarted.client.emit(message(incoming('first', 30)))
      await advance(OPTIONS.order.windowMs)

      expect(names(restarted)).toEqual([
        'ready:',
        'message:first',
        'message:second',
        'message:third',
        'message_batch:'
      ])
      // The counter went on from the process that crashed
      expect(seqs(restarted)).toEqual([2, 3, 4, 5, 6])
      expect([...env.messages.rows.values()].every(row => row.emittedAt !== null)).toBe(true)
    })

    it('does not publish again what was published, nor the messages of the session itself', async () => {
      const env = environment()
      const row = (id: string, overrides: Partial<Row>): Row => ({
        ...incomingRow(id),
        ...overrides
      })
      env.messages.rows.set('done', row('done', { emittedAt: new Date() }))
      env.messages.rows.set('mine', row('mine', { direction: 'out', fromMe: true }))
      env.messages.rows.set('pending', row('pending', {}))
      open(env)

      env.client.emit({ event: 'ready', data: {} })
      await advance(OPTIONS.order.windowMs)

      expect(names(env)).toEqual(['ready:', 'message:pending'])
    })

    it('recovers again on every ready without repeating a message that is still held', async () => {
      const env = environment()
      open(env)
      env.client.emit(message(incoming('a', 10)))
      env.client.emit({ event: 'ready', data: {} })
      await advance(0)
      env.client.emit({ event: 'ready', data: {} })
      await advance(OPTIONS.order.windowMs)

      expect(env.published.filter(envelope => envelope.event === 'message')).toHaveLength(1)
    })

    it('does not publish twice a message whose direct publish is still in flight', async () => {
      const env = environment()
      let release: () => void = () => undefined
      env.nextSeq.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = () => resolve(1)
          })
      )
      open(env)

      env.client.emit(message(incoming('a', 0)))
      env.client.emit({ event: 'ready', data: {} })
      await advance(0)
      release()
      await advance(OPTIONS.order.windowMs)

      expect(env.published.filter(envelope => envelope.event === 'message')).toHaveLength(1)
    })

    it('keeps handling events while a recovery waits for a publish in flight', async () => {
      const env = environment()
      let release: () => void = () => undefined
      env.nextSeq.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = () => resolve(1)
          })
      )
      open(env)

      env.client.emit(message(incoming('a', 0)))
      env.client.emit({ event: 'ready', data: {} })
      env.client.emit(message(incoming('b', 0)))
      await advance(0)
      // `a` is still being stamped, and `b` was already stored behind the ready
      expect(env.messages.rows.has('b')).toBe(true)
      release()
      await advance(OPTIONS.order.windowMs)

      expect(names(env).filter(name => name.startsWith('message:'))).toEqual([
        'message:a',
        'message:b'
      ])
    })

    it('publishes the stored messages in order, one by one, when ordering is off', async () => {
      const env = environment()
      env.messages.rows.set('b', { ...incomingRow('b'), sentAt: new Date(NOW.getTime() - 5000) })
      env.messages.rows.set('a', { ...incomingRow('a'), sentAt: new Date(NOW.getTime() - 9000) })
      open(env, { orderingEnabled: false })

      env.client.emit({ event: 'ready', data: {} })
      await advance(0)

      expect(names(env)).toEqual(['ready:', 'message:a', 'message:b'])
    })

    it('skips, and counts, a stored message that no longer fits the DTO', async () => {
      const env = environment()
      env.messages.rows.set('bad', { ...incomingRow('bad'), dto: { id: 'bad' } })
      env.messages.rows.set('good', incomingRow('good'))
      open(env)

      env.client.emit({ event: 'ready', data: {} })
      await advance(OPTIONS.order.windowMs)

      expect(names(env)).toEqual(['ready:', 'message:good'])
      expect(await countOf(env, 'replay')).toBe(1)
    })

    it('counts a recovery that cannot read the table', async () => {
      const env = environment()
      jest.spyOn(env.messages, 'listUnemitted').mockRejectedValue(new Error('db down'))
      open(env)

      env.client.emit({ event: 'ready', data: {} })
      await advance(0)

      expect(names(env)).toEqual(['ready:'])
      expect(await countOf(env, 'replay')).toBe(1)
    })
  })

  describe('a failure while publishing', () => {
    it('publishes the rest of the batch in order after the replay, without repeating what went out', async () => {
      const env = environment()
      open(env)
      // First stamp works, then Redis fails once
      env.nextSeq.mockImplementationOnce(() => Promise.resolve(1))
      env.nextSeq.mockImplementationOnce(() => Promise.reject(new Error('redis down')))
      env.nextSeq.mockImplementation(
        (() => {
          let seq = 1
          return () => Promise.resolve(++seq)
        })()
      )

      env.client.emit(message(incoming('c', 10)))
      env.client.emit(message(incoming('a', 30)))
      env.client.emit(message(incoming('b', 20)))
      await advance(OPTIONS.order.windowMs)

      expect(names(env)).toEqual(['message:a'])
      expect(env.messages.rows.get('a')?.emittedAt).not.toBeNull()
      expect(env.messages.rows.get('b')?.emittedAt).toBeNull()
      expect(await countOf(env, 'publish')).toBe(1)

      await advance(OPTIONS.replayDelayMs + OPTIONS.order.windowMs)

      // The remainder is a burst of its own, so it comes with its summary
      expect(names(env)).toEqual(['message:a', 'message:b', 'message:c', 'message_batch:'])
      expect(seqs(env)).toEqual([1, 2, 3, 4])
      expect([...env.messages.rows.values()].every(row => row.emittedAt !== null)).toBe(true)
    })

    it('replays only the chat that failed', async () => {
      const env = environment()
      open(env)
      env.nextSeq.mockImplementationOnce(() => Promise.reject(new Error('redis down')))
      env.nextSeq.mockImplementation(
        (() => {
          let seq = 0
          return () => Promise.resolve(++seq)
        })()
      )

      env.client.emit(message(incoming('x', 10)))
      await advance(OPTIONS.order.windowMs)
      expect(env.published).toEqual([])
      const spy = jest.spyOn(env.messages, 'listUnemitted')
      await advance(OPTIONS.replayDelayMs)

      expect(spy).toHaveBeenCalledWith(SESSION, CHAT)
      await advance(OPTIONS.order.windowMs)
      expect(names(env)).toEqual(['message:x'])
    })

    it('keeps retrying while Redis is down, with a single timer per chat', async () => {
      const env = environment()
      open(env)
      env.nextSeq.mockRejectedValue(new Error('redis down'))

      env.client.emit(message(incoming('x', 0)))
      env.client.emit(message(incoming('y', 0)))
      await advance(0)
      expect(pipelineTimers()).toBe(1)

      await advance(OPTIONS.replayDelayMs * 3 + OPTIONS.order.windowMs * 3)

      expect(env.published).toEqual([])
      expect(env.messages.rows.get('x')?.emittedAt).toBeNull()

      env.nextSeq.mockImplementation(
        (() => {
          let seq = 0
          return () => Promise.resolve(++seq)
        })()
      )
      await advance(OPTIONS.maxReplayDelayMs + OPTIONS.order.windowMs)

      expect(names(env)).toEqual(['message:x', 'message:y', 'message_batch:'])
    })

    it('waits twice as long after every failed replay, up to a maximum', async () => {
      const env = environment()
      open(env)
      env.nextSeq.mockRejectedValue(new Error('redis down'))
      const spy = jest.spyOn(env.messages, 'listUnemitted')
      const calledAt: number[] = []
      spy.mockImplementation((...args) => {
        calledAt.push(Date.now())
        return MemoryMessages.prototype.listUnemitted.apply(env.messages, args)
      })

      env.client.emit(message(incoming('x', 0)))
      await advance(OPTIONS.maxReplayDelayMs * 10)

      const gaps = calledAt.slice(1, 6).map((at, index) => at - (calledAt[index] ?? 0))
      // Each gap is the wait plus the debounce of the buffer that holds the replayed message
      const window = OPTIONS.order.windowMs
      expect(gaps).toEqual([
        10_000 + window,
        20_000 + window,
        40_000 + window,
        60_000 + window,
        60_000 + window
      ])
    })

    it('logs a failing stage once per interval and counts every failure', async () => {
      const env = environment()
      open(env)
      env.nextSeq.mockRejectedValue(new Error('redis down'))

      for (let n = 0; n < 5; n++) env.client.emit({ event: 'ready', data: {} })
      await advance(0)
      expect(await countOf(env, 'publish')).toBe(5)
      const logged = (): number =>
        (errorLog.mock.calls as unknown[][]).filter(call => String(call[0]).includes('publish'))
          .length
      expect(logged()).toBe(1)

      await advance(10_000)
      env.client.emit({ event: 'ready', data: {} })
      await advance(0)

      expect(logged()).toBe(2)
    })

    it('includes in the batch of the rest of a burst the messages that went out before the failure', async () => {
      const env = environment()
      open(env)
      let calls = 0
      env.nextSeq.mockImplementation(() => {
        calls += 1
        return calls === 2 ? Promise.reject(new Error('redis down')) : Promise.resolve(calls)
      })

      env.client.emit(message(incoming('c', 10)))
      env.client.emit(message(incoming('a', 30)))
      env.client.emit(message(incoming('b', 20)))
      await advance(OPTIONS.order.windowMs)
      expect(names(env)).toEqual(['message:a'])
      await advance(OPTIONS.replayDelayMs + OPTIONS.order.windowMs)

      const batch = env.published.find(envelope => envelope.event === 'message_batch')
      expect((batch?.data as { messages: MessageDto[] }).messages.map(m => m.id)).toEqual([
        'a',
        'b',
        'c'
      ])
      expect(batch?.data).toMatchObject({ count: 3, reason: 'burst' })
    })

    it('tries the replay again when the table cannot be read', async () => {
      const env = environment()
      open(env)
      env.nextSeq.mockRejectedValueOnce(new Error('redis down'))
      env.client.emit(message(incoming('x', 0)))
      await advance(0)
      const spy = jest
        .spyOn(env.messages, 'listUnemitted')
        .mockRejectedValueOnce(new Error('db down'))

      await advance(OPTIONS.replayDelayMs)
      expect(await countOf(env, 'replay')).toBe(1)
      // The second attempt waits twice as long
      await advance(OPTIONS.replayDelayMs * 2 + OPTIONS.order.windowMs)

      expect(spy).toHaveBeenCalledTimes(2)
      expect(names(env)).toEqual(['message:x'])
    })

    it('does not replay a chat after the pipeline closed', async () => {
      const env = environment()
      const pipeline = open(env)
      env.nextSeq.mockRejectedValueOnce(new Error('redis down'))
      env.client.emit(message(incoming('x', 0)))
      await advance(0)

      await pipeline.close()
      await advance(OPTIONS.replayDelayMs * 2)

      expect(env.published).toEqual([])
      expect(pipelineTimers()).toBe(0)
    })

    it('does not replay for the summary of a batch that fails after its messages went out', async () => {
      const env = environment()
      open(env)
      let seq = 0
      env.nextSeq.mockImplementation(() => {
        seq += 1
        return seq === 3 ? Promise.reject(new Error('redis down')) : Promise.resolve(seq)
      })

      env.client.emit(message(incoming('b', 10)))
      env.client.emit(message(incoming('a', 20)))
      await advance(OPTIONS.order.windowMs + OPTIONS.replayDelayMs * 2)

      expect(names(env)).toEqual(['message:a', 'message:b'])
      expect(pipelineTimers()).toBe(0)
    })

    it('leaves a message stored and unpublished when it fails outside the buffer, and replays it', async () => {
      const env = environment()
      open(env)
      env.nextSeq.mockRejectedValueOnce(new Error('redis down'))

      env.client.emit(message(incoming('x', 0)))
      await advance(0)
      expect(env.messages.rows.get('x')?.emittedAt).toBeNull()
      await advance(OPTIONS.replayDelayMs + OPTIONS.order.windowMs)

      expect(names(env)).toEqual(['message:x'])
    })

    it('counts a failure to mark as emitted without replaying', async () => {
      const env = environment()
      open(env)
      jest.spyOn(env.messages, 'markEmitted').mockRejectedValue(new Error('db down'))

      env.client.emit(message(incoming('x', 0)))
      await advance(OPTIONS.replayDelayMs * 2)

      expect(names(env)).toEqual(['message:x'])
      expect(await countOf(env, 'store')).toBe(1)
    })
  })

  describe('close', () => {
    it('drops what the buffer holds and publishes nothing afterwards', async () => {
      const env = environment()
      const pipeline = open(env)
      env.client.emit(message(incoming('a', 10)))
      await advance(0)

      await pipeline.close()
      await advance(OPTIONS.order.maxHoldMs * 2)

      expect(env.published).toEqual([])
      expect(env.messages.rows.get('a')?.emittedAt).toBeNull()
    })

    it('waits for the work in flight', async () => {
      const env = environment()
      let release: () => void = () => undefined
      env.nextSeq.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = () => resolve(1)
          })
      )
      const pipeline = open(env)
      env.client.emit({ event: 'ready', data: {} })
      await advance(0)

      let closed = false
      const closing = pipeline.close().then(() => {
        closed = true
      })
      await advance(0)
      expect(closed).toBe(false)
      release()
      await closing

      expect(closed).toBe(true)
    })
  })
})

describe('SessionEventPipeline (review findings)', () => {
  it('waits for a batch being published on close, and stops emitting after it', async () => {
    const env = environment()
    let unblock: () => void = () => undefined
    let calls = 0
    env.nextSeq.mockImplementation(() => {
      calls += 1
      if (calls !== 2) return Promise.resolve(calls)
      return new Promise(resolve => {
        unblock = () => resolve(calls)
      })
    })
    const pipeline = open(env)
    env.client.emit(message(incoming('c', 10)))
    env.client.emit(message(incoming('b', 20)))
    env.client.emit(message(incoming('a', 30)))
    await advance(OPTIONS.order.windowMs)

    let closed = false
    const closing = pipeline.close().then(() => {
      closed = true
    })
    await advance(0)
    expect(closed).toBe(false)
    unblock()
    await closing

    expect(names(env)).toEqual(['message:a', 'message:b'])
    expect(env.messages.rows.get('c')?.emittedAt).toBeNull()
    expect(env.messages.rows.get('b')?.emittedAt).not.toBeNull()
  })

  it('does not publish again a message whose batch finished while a recovery was reading', async () => {
    const env = environment()
    open(env)
    let gate: () => void = () => undefined
    const original = env.messages.listUnemitted.bind(env.messages)
    jest.spyOn(env.messages, 'listUnemitted').mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args)
      await new Promise<void>(resolve => {
        gate = resolve
      })
      return snapshot
    })

    env.client.emit(message(incoming('a', 10)))
    env.client.emit({ event: 'ready', data: {} })
    await advance(0)
    // The recovery read `a` as unpublished, then the batch of `a` went out and was marked
    await advance(OPTIONS.order.windowMs)
    gate()
    await advance(OPTIONS.order.windowMs * 3)

    expect(names(env).filter(name => name === 'message:a')).toHaveLength(1)
  })

  it('lets go of the dedupe claim when the message could not be stored', async () => {
    const env = environment()
    env.messages.failUpsert = true
    open(env)

    env.client.emit(message(incoming('a', 0)))
    await advance(0)

    expect(env.unclaim).toHaveBeenCalledWith(`dedupe:${SESSION}:message:a`)
  })

  it('keeps the claim when the message was stored', async () => {
    const env = environment()
    open(env)

    env.client.emit(message(incoming('a', 0)))
    await advance(0)

    expect(env.unclaim).not.toHaveBeenCalled()
  })

  it('notes the activity of an incoming live message, not of our own or other events', async () => {
    const env = environment()
    open(env)

    env.client.emit(message(incoming('mine', 0, { fromMe: true })))
    env.client.emit({ event: 'ready', data: {} })
    await advance(0)
    expect(env.noteIncoming).not.toHaveBeenCalled()

    env.client.emit(message(incoming('a', 0)))
    await advance(0)
    expect(env.noteIncoming).toHaveBeenCalledTimes(1)
  })

  it('notes the time the sender wrote the message, so a backlog does not look like news', async () => {
    const env = environment()
    open(env)
    const backlog = incoming('old', 7200)

    env.client.emit(message(backlog))
    await advance(0)

    expect(env.noteIncoming).toHaveBeenCalledWith(new Date(backlog.sentAt))
  })

  it('does not note a message that could not be stored', async () => {
    const env = environment()
    env.messages.failUpsert = true
    open(env)

    env.client.emit(message(incoming('a', 0)))
    await advance(0)

    expect(env.noteIncoming).not.toHaveBeenCalled()
  })

  it('does not note a repeat of a message the dedupe dropped', async () => {
    const env = environment()
    open(env)

    env.client.emit(message(incoming('a', 0)))
    env.client.emit(message(incoming('a', 0)))
    await advance(0)

    expect(env.noteIncoming).toHaveBeenCalledTimes(1)
  })

  it('does not schedule a replay for an outgoing message that failed to publish', async () => {
    const env = environment()
    open(env)
    env.nextSeq.mockRejectedValueOnce(new Error('redis down'))

    env.client.emit(created(incoming('mine', 0, { fromMe: true })))
    await advance(0)

    expect(pipelineTimers()).toBe(0)
  })

  it('publishes the events about a message, and under its own name, when its batch is replayed', async () => {
    const env = environment()
    open(env)
    let calls = 0
    env.nextSeq.mockImplementation(() => {
      calls += 1
      return calls === 2 ? Promise.reject(new Error('redis down')) : Promise.resolve(calls)
    })
    const b = incoming('b', 20)

    env.client.emit(message(incoming('c', 10)))
    env.client.emit(message(incoming('a', 30)))
    env.client.emit(created(b))
    env.client.emit(ack(b, 3))
    await advance(OPTIONS.order.windowMs)
    await advance(OPTIONS.replayDelayMs + OPTIONS.order.windowMs)

    expect(names(env).filter(name => !name.startsWith('message_batch'))).toEqual([
      'message:a',
      'message_create:b',
      'message_ack:b',
      'message:c'
    ])
  })

  it('marks as emitted, and counts once, a stored message that no longer fits the DTO', async () => {
    const env = environment()
    env.messages.rows.set('bad', { ...incomingRow('bad'), dto: { id: 'bad' } })
    open(env)

    env.client.emit({ event: 'ready', data: {} })
    await advance(OPTIONS.order.windowMs)
    env.client.emit({ event: 'ready', data: {} })
    await advance(OPTIONS.order.windowMs)

    expect(env.messages.rows.get('bad')?.emittedAt).not.toBeNull()
    expect(await countOf(env, 'replay')).toBe(1)
  })

  it('keeps the stream going, and counts it, when handling an event throws', async () => {
    const env = environment()
    open(env)

    // An event without the data its type promises: the handling of it throws
    env.client.emit({ event: 'message_ack', data: {} } as unknown as ClientEvent)
    env.client.emit({ event: 'ready', data: {} })
    await advance(0)

    expect(names(env)).toEqual(['ready:'])
    expect(await countOf(env, 'event')).toBe(1)
  })

  it('counts a failure that is not an Error', async () => {
    const env = environment()
    env.claim.mockRejectedValue('redis says no')
    open(env)

    env.client.emit(message(incoming('a', 0)))
    await advance(0)

    expect(names(env)).toEqual(['message:a'])
    expect(await countOf(env, 'dedupe')).toBe(1)
    expect((errorLog.mock.calls as unknown[][]).flat().join(' ')).toContain('string')
  })

  it('keeps the earlier messages of a burst when its replay fails too', async () => {
    const env = environment()
    open(env)
    let calls = 0
    env.nextSeq.mockImplementation(() => {
      calls += 1
      // a goes out; then b fails; then the replay fails at once; then everything works
      return calls === 2 || calls === 3
        ? Promise.reject(new Error('redis down'))
        : Promise.resolve(calls)
    })

    env.client.emit(message(incoming('c', 10)))
    env.client.emit(message(incoming('b', 20)))
    env.client.emit(message(incoming('a', 30)))
    await advance(OPTIONS.order.windowMs)
    await advance(OPTIONS.replayDelayMs + OPTIONS.order.windowMs)
    await advance(OPTIONS.replayDelayMs * 2 + OPTIONS.order.windowMs)

    const batch = env.published.find(envelope => envelope.event === 'message_batch')
    expect((batch?.data as { messages: MessageDto[] }).messages.map(m => m.id)).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('replays a failed publish when ordering is off', async () => {
    const env = environment()
    open(env, { orderingEnabled: false })
    env.nextSeq.mockRejectedValueOnce(new Error('redis down'))

    env.client.emit(message(incoming('x', 0)))
    await advance(0)
    expect(env.published).toEqual([])
    await advance(OPTIONS.replayDelayMs)

    expect(names(env)).toEqual(['message:x'])
    expect(env.messages.rows.get('x')?.emittedAt).not.toBeNull()
  })

  it('does not block the stream when the ack cannot be stored', async () => {
    const env = environment()
    open(env)
    const sent = incoming('a', 0, { fromMe: true })
    env.client.emit(created(sent))
    await advance(0)
    jest.spyOn(env.messages, 'updateAck').mockRejectedValueOnce(new Error('db down'))

    env.client.emit(ack(sent, 3))
    await advance(0)

    expect(env.published.map(envelope => envelope.event)).toEqual(['message_create', 'message_ack'])
    expect(await countOf(env, 'store')).toBe(1)
    expect(env.unclaim).toHaveBeenCalledWith(`dedupe:${SESSION}:message_ack:a:3`)
  })

  it('does not replay a failed batch made only of our own messages', async () => {
    const env = environment()
    open(env)
    env.nextSeq.mockRejectedValueOnce(new Error('redis down'))

    env.client.emit(created(incoming('mine', 10, { fromMe: true })))
    await advance(OPTIONS.order.windowMs)
    // `created` of a message that is late joins the buffer; its release fails
    expect(pipelineTimers()).toBe(0)
  })

  it('forgets the context of a burst that has nothing left to replay', async () => {
    const env = environment()
    open(env)
    let calls = 0
    env.nextSeq.mockImplementation(() => {
      calls += 1
      return calls === 2 ? Promise.reject(new Error('redis down')) : Promise.resolve(calls)
    })
    env.client.emit(message(incoming('b', 10)))
    env.client.emit(message(incoming('a', 20)))
    await advance(OPTIONS.order.windowMs)
    // Another process published the rest: the replay finds no row
    for (const row of env.messages.rows.values()) row.emittedAt = new Date()
    await advance(OPTIONS.replayDelayMs)

    // A later, unrelated burst of the chat does not list `a`
    env.client.emit(message(incoming('d', 10)))
    env.client.emit(message(incoming('c', 20)))
    await advance(OPTIONS.order.windowMs)

    const batch = env.published.filter(envelope => envelope.event === 'message_batch').at(-1)
    expect((batch?.data as { messages: MessageDto[] }).messages.map(m => m.id)).toEqual(['c', 'd'])
  })

  it('lists a message once in the batch even when it went out twice', async () => {
    const env = environment()
    open(env)
    let calls = 0
    env.nextSeq.mockImplementation(() => {
      calls += 1
      return calls === 3 ? Promise.reject(new Error('redis down')) : Promise.resolve(calls)
    })
    // a and b are out, but their rows stay unpublished, so the replay sends them again
    jest.spyOn(env.messages, 'markEmitted').mockRejectedValueOnce(new Error('db down'))

    env.client.emit(message(incoming('c', 10)))
    env.client.emit(message(incoming('b', 20)))
    env.client.emit(message(incoming('a', 30)))
    await advance(OPTIONS.order.windowMs)
    await advance(OPTIONS.replayDelayMs + OPTIONS.order.windowMs)

    const batch = env.published.find(envelope => envelope.event === 'message_batch')
    const data = batch?.data as { messages: MessageDto[]; count: number }
    expect(data.messages.map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(data.count).toBe(3)
  })
})

describe('SessionEventPipeline send policy', () => {
  it('shows an incoming message to the policy before it is published, then marks it handled', async () => {
    const env = environment()
    open(env)

    env.client.emit(message(incoming('a', 1)))
    await advance(0)

    expect(env.handleIncoming).toHaveBeenCalledWith(CHAT, 'text of a')
    expect(env.messages.rows.get('a')?.policyHandledAt).toEqual(NOW)
    expect(names(env)).toEqual(['message:a'])
  })

  it('publishes chat_suppressed ahead of the message when the policy suppressed the chat', async () => {
    const env = environment()
    env.handleIncoming.mockResolvedValue(true)
    open(env)

    env.client.emit(message(incoming('a', 1, { body: 'stop' })))
    await advance(0)

    expect(names(env)).toEqual(['chat_suppressed:', 'message:a'])
    expect(env.published[0]?.data).toEqual({ chatId: CHAT, reason: 'opt_out' })
  })

  it('does not show our own messages to the policy', async () => {
    const env = environment()
    open(env)

    env.client.emit(message(incoming('a', 1, { fromMe: true })))
    await advance(0)

    expect(env.handleIncoming).not.toHaveBeenCalled()
  })

  it('still publishes the message when the policy fails, and retries until it answers', async () => {
    const env = environment()
    env.handleIncoming.mockRejectedValueOnce(new Error('redis down'))
    env.handleIncoming.mockResolvedValue(true)
    open(env)

    env.client.emit(message(incoming('a', 1, { body: 'stop' })))
    await advance(0)

    expect(names(env)).toEqual(['message:a'])
    expect(env.messages.rows.get('a')?.policyHandledAt).toBeNull()
    expect(await countOf(env, 'policy')).toBe(1)

    await advance(OPTIONS.replayDelayMs)

    expect(env.handleIncoming).toHaveBeenCalledTimes(2)
    expect(env.messages.rows.get('a')?.policyHandledAt).not.toBeNull()
    expect(names(env)).toEqual(['message:a', 'chat_suppressed:'])
  })

  it('counts a policy that never answers as a failure', async () => {
    const env = environment()
    env.handleIncoming.mockReturnValueOnce(new Promise(() => undefined))
    open(env)

    env.client.emit(message(incoming('a', 1)))
    await advance(OPTIONS.policyTimeoutMs)

    expect(await countOf(env, 'policy')).toBe(1)
    expect(names(env)).toEqual(['message:a'])
  })

  it('shows the policy the messages a crash left unseen when the session is ready again', async () => {
    const first = environment()
    first.handleIncoming.mockRejectedValue(new Error('down'))
    const crashed = open(first)
    first.client.emit(message(incoming('a', 1, { body: 'stop' })))
    await advance(0)
    await crashed.close()

    const second = environment(first)
    second.handleIncoming.mockResolvedValue(true)
    open(second)
    second.client.emit({ event: 'ready', data: {} })
    await advance(0)

    expect(second.handleIncoming).toHaveBeenCalledWith(CHAT, 'stop')
    expect(second.messages.rows.get('a')?.policyHandledAt).not.toBeNull()
    expect(names(second)).toContain('chat_suppressed:')
  })

  it('does nothing while no policy is provided, and leaves the message pending', async () => {
    const env = environment()
    const sequencer = new EventSequencer({
      nextSeq: sessionId => env.nextSeq(sessionId),
      publish: envelope => env.published.push(envelope)
    })
    const pipeline = new SessionEventPipeline(OPTIONS, {
      client: env.client,
      messages: env.messages,
      sequencer,
      claim: key => env.claim(key),
      unclaim: key => env.unclaim(key),
      noteIncoming: at => env.noteIncoming(at),
      metrics: env.metrics.metrics
    })
    pipeline.start()
    pipelines.push(pipeline)

    env.client.emit(message(incoming('a', 1)))
    await advance(0)

    expect(names(env)).toEqual(['message:a'])
    expect(env.messages.rows.get('a')?.policyHandledAt).toBeNull()
  })

  it('keeps a short text for the policy while bodies are not stored, and drops it once seen', async () => {
    const env = environment()
    env.handleIncoming.mockRejectedValueOnce(new Error('down'))
    open(env, { storeBodies: false })

    env.client.emit(message(incoming('a', 1, { body: 'stop' })))
    await advance(0)

    expect(env.messages.rows.get('a')?.body).toBeNull()
    expect(env.messages.rows.get('a')?.policyText).toBe('stop')

    await advance(OPTIONS.replayDelayMs)

    expect(env.handleIncoming).toHaveBeenLastCalledWith(CHAT, 'stop')
    expect(env.messages.rows.get('a')?.policyText).toBeNull()
  })

  it('keeps no text for the policy when it is long or when bodies are stored', async () => {
    const env = environment()
    open(env, { storeBodies: false })

    env.client.emit(message(incoming('long', 1, { body: 'x'.repeat(65) })))
    await advance(0)
    expect(env.messages.rows.get('long')?.policyText).toBeNull()

    const stored = environment()
    open(stored)
    stored.client.emit(message(incoming('b', 1, { body: 'stop' })))
    await advance(0)
    expect(stored.messages.rows.get('b')?.policyText).toBeNull()
  })

  it('retries a chat_suppressed that could not be published', async () => {
    const env = environment()
    env.handleIncoming.mockResolvedValue(true)
    env.nextSeq.mockRejectedValueOnce(new Error('redis down'))
    open(env)

    env.client.emit(message(incoming('a', 1, { body: 'stop' })))
    await advance(0)
    expect(names(env)).toEqual(['message:a'])

    await advance(OPTIONS.replayDelayMs)

    expect(names(env)).toEqual(['message:a', 'chat_suppressed:'])
  })

  it('does not show the policy a message it has already seen again', async () => {
    const env = environment()
    open(env)

    env.client.emit(message(incoming('a', 1, { body: 'stop' })))
    env.client.emit(created(incoming('a', 1, { body: 'stop' })))
    await advance(0)

    expect(env.handleIncoming).toHaveBeenCalledTimes(1)
  })

  it('leaves the messages pending, without waiting, while the policy is known to be down', async () => {
    const env = environment()
    env.handleIncoming.mockRejectedValueOnce(new Error('down'))
    open(env)

    env.client.emit(message(incoming('a', 1)))
    env.client.emit(message(incoming('b', 1)))
    await advance(0)

    expect(env.handleIncoming).toHaveBeenCalledTimes(1)
    expect(names(env)).toEqual(['message:a', 'message:b'])

    await advance(OPTIONS.replayDelayMs)

    expect(env.handleIncoming).toHaveBeenCalledTimes(3)
    expect(env.messages.rows.get('b')?.policyHandledAt).not.toBeNull()
  })

  it('stops the pass and backs off when a message cannot be marked as handled', async () => {
    const env = environment()
    jest.spyOn(env.messages, 'markPolicyHandled').mockRejectedValue(new Error('db down'))
    open(env)

    env.client.emit(message(incoming('a', 1)))
    await advance(0)
    await advance(OPTIONS.replayDelayMs)
    await advance(OPTIONS.replayDelayMs)

    // 5 s then 10 s: the second wait is not over yet
    expect(env.handleIncoming).toHaveBeenCalledTimes(2)
  })

  it('stops retrying when it is closed', async () => {
    const env = environment()
    env.handleIncoming.mockRejectedValue(new Error('down'))
    const pipeline = open(env)

    env.client.emit(message(incoming('a', 1)))
    await advance(0)
    await pipeline.close()
    await advance(OPTIONS.maxReplayDelayMs)

    expect(env.handleIncoming).toHaveBeenCalledTimes(1)
  })
})

function incomingRow(id: string): Row {
  const dto = incoming(id, 10)
  return {
    id,
    sessionId: SESSION,
    chatId: dto.chatId,
    direction: 'in',
    fromMe: false,
    type: 'chat',
    body: dto.body,
    hasMedia: false,
    ack: 1,
    sentAt: new Date(dto.sentAt),
    receivedAt: new Date(dto.receivedAt),
    emittedAt: null,
    policyHandledAt: null,
    policyText: null,
    origin: null,
    dto: JSON.parse(JSON.stringify(dto)) as Row['dto'],
    createdAt: new Date()
  }
}
