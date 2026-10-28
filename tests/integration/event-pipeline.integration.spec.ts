import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import type { TestingModule } from '@nestjs/testing'

import { parseEnv } from '../../src/config/env.schema.js'
import { MessagesRepository } from '../../src/database/repositories/messages.repository.js'
import { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import { MetricsService } from '../../src/infra/metrics/metrics.service.js'
import { RedisService } from '../../src/infra/redis/redis.service.js'
import type { MessageDto } from '../../src/types/dto.js'
import type { EventEnvelope } from '../../src/types/events.js'
import { EventBusService } from '../../src/whatsapp/event-bus.service.js'
import { EventSequencer } from '../../src/whatsapp/event-pipeline.sequencer.js'
import { EventPipelineService } from '../../src/whatsapp/event-pipeline.service.js'
import {
  SessionEventPipeline,
  type SessionPipelineOptions
} from '../../src/whatsapp/event-pipeline.session.js'
import { buildDatabaseModule } from '../helpers/database.js'
import { REAL_ENV, TEST_ENV } from '../helpers/env.js'
import { FakeWhatsAppClient, buildMessageDto } from '../helpers/fake-whatsapp-client.js'

const CHAT = '5215500000001@c.us'

const OPTIONS: Omit<SessionPipelineOptions, 'sessionId'> = {
  orderingEnabled: true,
  // A window wide enough for the Postgres and Redis round trips between the messages of a burst,
  // even on a slow runner: a burst that outlasts it is split in two buffers
  order: { lateThresholdS: 3, windowMs: 1000, maxHoldMs: 4000, maxMessages: 200 },
  storeBodies: true,
  replayDelayMs: 80,
  maxReplayDelayMs: 400,
  fetchTimeoutMs: 1000
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

// A message the sender wrote `writtenAgoS` seconds before it reached the gateway
function incoming(id: string, writtenAgoS: number): MessageDto {
  return buildMessageDto({
    id,
    chatId: CHAT,
    from: CHAT,
    fromMe: false,
    body: `text of ${id}`,
    sentAt: new Date(Date.now() - writtenAgoS * 1000).toISOString(),
    receivedAt: new Date().toISOString()
  })
}

describe('event pipeline (integration)', () => {
  let module: TestingModule
  let messages: MessagesRepository
  let sessions: SessionsRepository
  let redis: RedisService
  const runId = randomUUID().slice(0, 8)
  const sessionIds: string[] = []
  const open: SessionEventPipeline[] = []

  const redisUrl = REAL_ENV.REDIS_URL
  if (redisUrl === undefined) throw new Error('REDIS_URL is required by the integration suites')
  const config = parseEnv({ ...TEST_ENV, REDIS_URL: redisUrl })

  beforeAll(async () => {
    module = await buildDatabaseModule()
    await module.init()
    messages = module.get(MessagesRepository)
    sessions = module.get(SessionsRepository)
    redis = new RedisService(config)
    // The pipeline refuses Redis commands until the connection is ready
    await redis.client.ping()
    // The first query of the Prisma pool is the slowest: take it before the timed tests
    await sessions.list()
  })

  afterAll(async () => {
    for (const id of sessionIds) {
      await sessions.delete(id)
      const keys = [...(await redis.client.keys(`*:${id}*`)), `seq:${id}`]
      await redis.client.del(...keys)
    }
    await redis.onApplicationShutdown()
    await module.close()
  })

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation()
  })

  afterEach(async () => {
    await Promise.all(open.splice(0).map(pipeline => pipeline.close()))
    jest.restoreAllMocks()
  })

  async function newSession(name: string): Promise<string> {
    const id = `${name}-${runId}`
    await sessions.create({ id })
    sessionIds.push(id)
    return id
  }

  // What the process has: a client, a sequencer on the real Redis, and the pipeline of the session
  function startProcess(sessionId: string): {
    client: FakeWhatsAppClient
    published: EventEnvelope[]
    pipeline: SessionEventPipeline
  } {
    const client = new FakeWhatsAppClient(sessionId)
    const published: EventEnvelope[] = []
    const sequencer = new EventSequencer({
      nextSeq: id => redis.client.incr(`seq:${id}`),
      publish: envelope => published.push(envelope)
    })
    const pipeline = new SessionEventPipeline(
      { ...OPTIONS, sessionId },
      {
        client,
        messages,
        sequencer,
        claim: async key => (await redis.client.set(key, '1', 'EX', 600, 'NX')) === 'OK',
        unclaim: async key => {
          await redis.client.del(key)
        },
        metrics: new MetricsService().metrics
      }
    )
    pipeline.start()
    open.push(pipeline)
    return { client, published, pipeline }
  }

  const messageIds = (published: EventEnvelope[]): string[] =>
    published.filter(envelope => envelope.event === 'message').map(e => e.data.id)

  const unemitted = async (sessionId: string): Promise<number> =>
    (await messages.listUnemitted(sessionId)).length

  it('stores, orders and publishes a burst with consecutive seq, and marks it as emitted', async () => {
    const sessionId = await newSession('burst')
    const { client, published } = startProcess(sessionId)

    client.emit({ event: 'message', data: incoming('c', 10) })
    client.emit({ event: 'message', data: incoming('a', 30) })
    client.emit({ event: 'message', data: incoming('b', 20) })
    await until(() => published.length === 4)

    expect(messageIds(published)).toEqual(['a', 'b', 'c'])
    expect(published.map(envelope => envelope.seq)).toEqual([1, 2, 3, 4])
    expect(published[3]?.event).toBe('message_batch')
    expect(await unemitted(sessionId)).toBe(0)
  })

  it('drops a message the client emits twice, using Redis', async () => {
    const sessionId = await newSession('dedupe')
    const { client, published, pipeline } = startProcess(sessionId)
    const duplicate = incoming('dup', 0)

    client.emit({ event: 'message', data: duplicate })
    client.emit({ event: 'message', data: duplicate })
    await until(() => published.length === 1)
    // Closing waits for everything in flight, so a second publish would show up by now
    await pipeline.close()

    expect(published).toHaveLength(1)
  })

  it('keeps seq increasing, and the dedupe, across a restart of the process', async () => {
    const sessionId = await newSession('restart')
    const before = startProcess(sessionId)
    before.client.emit({ event: 'message', data: incoming('one', 0) })
    await until(() => before.published.length === 1)
    await before.pipeline.close()

    const after = startProcess(sessionId)
    after.client.emit({ event: 'message', data: incoming('one', 0) })
    after.client.emit({ event: 'message', data: incoming('two', 0) })
    await until(() => after.published.length === 1)
    await after.pipeline.close()

    expect(messageIds(after.published)).toEqual(['two'])
    expect(after.published[0]?.seq).toBe(2)
  })

  it('publishes in order what a crashed process held, on the next ready', async () => {
    const sessionId = await newSession('crash')
    const crashed = startProcess(sessionId)
    crashed.client.emit({ event: 'message', data: incoming('third', 10) })
    crashed.client.emit({ event: 'message', data: incoming('first', 30) })
    crashed.client.emit({ event: 'message', data: incoming('second', 20) })
    await until(async () => (await unemitted(sessionId)) === 3)
    // The process dies while the buffer holds the burst
    await crashed.pipeline.close()
    expect(crashed.published).toEqual([])

    const restarted = startProcess(sessionId)
    restarted.client.emit({ event: 'ready', data: {} })
    await until(() => restarted.published.length === 5)

    expect(restarted.published.map(envelope => envelope.event)).toEqual([
      'ready',
      'message',
      'message',
      'message',
      'message_batch'
    ])
    expect(messageIds(restarted.published)).toEqual(['first', 'second', 'third'])
    expect(restarted.published.map(envelope => envelope.seq)).toEqual([1, 2, 3, 4, 5])
    expect(await unemitted(sessionId)).toBe(0)
  })

  it('publishes the rest of a batch, in order, after Redis fails halfway', async () => {
    const sessionId = await newSession('redis-fails')
    const { client, published } = startProcess(sessionId)
    const incr = redis.client.incr.bind(redis.client)
    let calls = 0
    jest.spyOn(redis.client, 'incr').mockImplementation(((key: string) => {
      calls += 1
      // The first stamp of the batch works, the second fails
      return calls === 2 ? Promise.reject(new Error('redis down')) : incr(key)
    }) as typeof redis.client.incr)

    client.emit({ event: 'message', data: incoming('c', 10) })
    client.emit({ event: 'message', data: incoming('a', 30) })
    client.emit({ event: 'message', data: incoming('b', 20) })
    await until(() => messageIds(published).length === 3)

    expect(messageIds(published)).toEqual(['a', 'b', 'c'])
    const seqs = published.map(envelope => envelope.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(seqs).size).toBe(seqs.length)
    await until(async () => (await unemitted(sessionId)) === 0)
  })

  it('takes the seq and the dedupe of the service from Redis', async () => {
    const sessionId = await newSession('service')
    const bus = new EventBusService()
    const published: EventEnvelope[] = []
    bus.subscribe('*', envelope => {
      published.push(envelope)
    })
    const service = new EventPipelineService(config, redis, messages, bus, new MetricsService())
    const client = new FakeWhatsAppClient(sessionId)
    await service.open(sessionId, client, { orderingEnabled: true })

    try {
      client.emit({ event: 'message', data: incoming('only', 0) })
      client.emit({ event: 'message', data: incoming('only', 0) })
      await until(() => published.length === 1)
      await service.publish(sessionId, 'ping', {})
    } finally {
      await service.close(sessionId)
    }

    expect(published.map(envelope => [envelope.event, envelope.seq])).toEqual([
      ['message', 1],
      ['ping', 2]
    ])
    expect(await redis.client.get(`seq:${sessionId}`)).toBe('2')
  })
})
