import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { FakeWhatsAppClient, buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import { parseEnv } from '../config/env.schema.js'
import type { MessagesRepository } from '../database/repositories/messages.repository.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { RedisService } from '../infra/redis/redis.service.js'
import type { EventEnvelope } from '../types/events.js'

import { EventBusService } from './event-bus.service.js'
import { EventPipelineService } from './event-pipeline.service.js'

const SESSION = 'support-line'
const NOW = new Date('2026-10-27T12:00:00.000Z')

interface Built {
  service: EventPipelineService
  bus: EventBusService
  published: EventEnvelope[]
  redis: { status: string; incr: jest.Mock; set: jest.Mock; del: jest.Mock }
  messages: Record<'upsert' | 'updateAck' | 'markEmitted' | 'listUnemitted', jest.Mock>
  sessions: Record<'findById' | 'update' | 'raiseSeqHighWater', jest.Mock>
}

function build(env: Record<string, string> = {}): Built {
  const bus = new EventBusService()
  const published: EventEnvelope[] = []
  bus.subscribe('*', envelope => {
    published.push(envelope)
  })
  let seq = 0
  const redis = {
    status: 'ready',
    incr: jest.fn(() => Promise.resolve(++seq)),
    set: jest.fn(() => Promise.resolve('OK')),
    del: jest.fn(() => Promise.resolve(1))
  }
  const messages = {
    upsert: jest.fn(() => Promise.resolve({})),
    updateAck: jest.fn(() => Promise.resolve(true)),
    markEmitted: jest.fn(() => Promise.resolve(1)),
    listUnemitted: jest.fn(() => Promise.resolve([]))
  }
  const sessions = {
    findById: jest.fn(() => Promise.resolve({ seqHighWater: 0n })),
    update: jest.fn(() => Promise.resolve({})),
    raiseSeqHighWater: jest.fn(() => Promise.resolve())
  }
  const service = new EventPipelineService(
    parseEnv({ ...TEST_ENV, ...env }),
    { client: redis } as unknown as RedisService,
    messages as unknown as MessagesRepository,
    sessions as unknown as SessionsRepository,
    bus,
    new MetricsService()
  )
  return { service, bus, published, redis, messages, sessions }
}

const flush = (): Promise<void> => jest.advanceTimersByTimeAsync(0)

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  jest.spyOn(Logger.prototype, 'error').mockImplementation()
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('EventPipelineService', () => {
  it('runs the events of a client through the pipeline to the bus', async () => {
    const { service, published, redis, messages } = build()
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })

    client.emit({
      event: 'message',
      data: buildMessageDto({
        id: 'a',
        fromMe: false,
        sentAt: NOW.toISOString(),
        receivedAt: NOW.toISOString()
      })
    })
    await flush()

    expect(published).toMatchObject([{ event: 'message', sessionId: SESSION, seq: 1 }])
    expect(redis.set).toHaveBeenCalledWith(`dedupe:${SESSION}:message:a`, '1', 'EX', 600, 'NX')
    expect(redis.incr).toHaveBeenCalledWith(`seq:${SESSION}`)
    expect(messages.upsert).toHaveBeenCalledTimes(1)
  })

  it('treats a key Redis already has as a repeat', async () => {
    const { service, published, redis } = build()
    redis.set.mockResolvedValueOnce(null)
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })

    client.emit({ event: 'message', data: buildMessageDto({ id: 'a', fromMe: false }) })
    await flush()

    expect(published).toEqual([])
  })

  it('holds late messages only when both the gateway and the session have ordering on', async () => {
    const late = buildMessageDto({
      id: 'late',
      fromMe: false,
      sentAt: new Date(NOW.getTime() - 20_000).toISOString(),
      receivedAt: NOW.toISOString()
    })
    const on = build()
    const off = build({ INBOUND_ORDERING_ENABLED: 'false' })
    const sessionOff = build()
    const clients = [on, off, sessionOff].map(() => new FakeWhatsAppClient(SESSION))
    await on.service.open(SESSION, clients[0] as FakeWhatsAppClient, { orderingEnabled: true })
    await off.service.open(SESSION, clients[1] as FakeWhatsAppClient, { orderingEnabled: true })
    await sessionOff.service.open(SESSION, clients[2] as FakeWhatsAppClient, {
      orderingEnabled: false
    })

    for (const client of clients) client.emit({ event: 'message', data: late })
    await flush()

    expect(on.published).toEqual([])
    expect(off.published).toHaveLength(1)
    expect(sessionOff.published).toHaveLength(1)
  })

  it('reads the ordering window from the configuration', async () => {
    const { service, published } = build({ INBOUND_ORDER_WINDOW_MS: '200' })
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })
    const late = buildMessageDto({
      id: 'late',
      fromMe: false,
      sentAt: new Date(NOW.getTime() - 20_000).toISOString(),
      receivedAt: NOW.toISOString()
    })

    client.emit({ event: 'message', data: late })
    await jest.advanceTimersByTimeAsync(199)
    expect(published).toEqual([])
    await jest.advanceTimersByTimeAsync(1)

    expect(published).toHaveLength(1)
  })

  it('closes the pipeline a session had when it opens it again', async () => {
    const { service } = build()
    const first = new FakeWhatsAppClient(SESSION)
    const second = new FakeWhatsAppClient(SESSION)

    await service.open(SESSION, first, { orderingEnabled: true })
    await service.open(SESSION, second, { orderingEnabled: true })

    expect(first.listenerCount).toBe(0)
    expect(second.listenerCount).toBe(1)
  })

  it('keeps a single pipeline when a session is opened twice at the same time', async () => {
    const { service } = build()
    const first = new FakeWhatsAppClient(SESSION)
    const second = new FakeWhatsAppClient(SESSION)

    await Promise.all([
      service.open(SESSION, first, { orderingEnabled: true }),
      service.open(SESSION, second, { orderingEnabled: true })
    ])

    expect(first.listenerCount).toBe(0)
    expect(second.listenerCount).toBe(1)
  })

  it('stops a session and ignores one it does not know', async () => {
    const { service } = build()
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })

    await service.close(SESSION)
    await service.close('unknown')

    expect(client.listenerCount).toBe(0)
  })

  it('stops every session on shutdown', async () => {
    const { service } = build()
    const a = new FakeWhatsAppClient('a')
    const b = new FakeWhatsAppClient('b')
    await service.open('a', a, { orderingEnabled: true })
    await service.open('b', b, { orderingEnabled: true })

    await service.onApplicationShutdown()

    expect([a.listenerCount, b.listenerCount]).toEqual([0, 0])
  })

  it('gives the events it publishes the same seq counter as the ones of the client', async () => {
    const { service, published } = build()
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })

    client.emit({ event: 'ready', data: {} })
    await flush()
    await service.publish(SESSION, 'session_status', { status: 'ready', previous: 'starting' })
    await service.publish('other', 'ping', {})

    expect(published.map(envelope => [envelope.sessionId, envelope.event, envelope.seq])).toEqual([
      [SESSION, 'ready', 1],
      [SESSION, 'session_status', 2],
      ['other', 'ping', 3]
    ])
  })

  it('rejects a publish when Redis cannot give a seq', async () => {
    const { service, redis, published } = build()
    redis.incr.mockRejectedValueOnce(new Error('redis down'))

    await expect(service.publish(SESSION, 'ping', {})).rejects.toThrow('redis down')

    expect(published).toEqual([])
  })

  it('fails at once, without waiting for a timeout, while Redis is not connected', async () => {
    const { service, redis, published, messages } = build()
    redis.status = 'reconnecting'
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })

    await expect(service.publish(SESSION, 'ping', {})).rejects.toThrow('redis is not connected')
    client.emit({ event: 'message', data: buildMessageDto({ id: 'a', fromMe: false }) })
    await flush()

    expect(redis.incr).not.toHaveBeenCalled()
    // The dedupe is skipped, the message is stored, and it waits for the replay
    expect(redis.set).not.toHaveBeenCalled()
    expect(messages.upsert).toHaveBeenCalledTimes(1)
    expect(published).toEqual([])
  })

  it('goes on when the dedupe does not answer within a second', async () => {
    const { service, redis, published } = build()
    redis.set.mockImplementationOnce(() => new Promise<string>(() => undefined))
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })

    client.emit({ event: 'message', data: buildMessageDto({ id: 'a', fromMe: false }) })
    await jest.advanceTimersByTimeAsync(999)
    expect(published).toEqual([])
    await jest.advanceTimersByTimeAsync(1)

    expect(published).toMatchObject([{ event: 'message' }])
  })

  it('replays the stored message once Redis is connected again', async () => {
    const { service, redis, published, messages } = build()
    redis.status = 'reconnecting'
    const client = new FakeWhatsAppClient(SESSION)
    await service.open(SESSION, client, { orderingEnabled: true })
    const dto = buildMessageDto({
      id: 'a',
      fromMe: false,
      sentAt: NOW.toISOString(),
      receivedAt: NOW.toISOString()
    })
    messages.listUnemitted.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'a',
          sessionId: SESSION,
          chatId: dto.chatId,
          direction: 'in',
          dto: JSON.parse(JSON.stringify(dto)) as unknown
        }
      ])
    )

    client.emit({ event: 'message', data: dto })
    await flush()
    expect(published).toEqual([])
    redis.status = 'ready'
    await jest.advanceTimersByTimeAsync(5000 + 1500)

    expect(published).toMatchObject([{ event: 'message', seq: 1 }])
  })

  it('gives up on a Redis that does not answer instead of stalling the stream', async () => {
    const { service, redis, published } = build()
    redis.incr.mockImplementationOnce(() => new Promise<number>(() => undefined))

    const stalled = service.publish(SESSION, 'ping', {})
    const outcome = expect(stalled).rejects.toMatchObject({ code: 'WHATSAPP_TIMEOUT' })
    await jest.advanceTimersByTimeAsync(5000)
    await outcome
    await service.publish(SESSION, 'ping', {})

    expect(published).toHaveLength(1)
  })
})

describe('EventPipelineService seq bound', () => {
  it('starts above the bound the database holds, and corrects Redis', async () => {
    const { service, published, sessions, redis } = build()
    sessions.findById.mockResolvedValue({ seqHighWater: 250n })
    await service.open(SESSION, new FakeWhatsAppClient(SESSION), { orderingEnabled: true })

    await service.publish(SESSION, 'ping', {})

    expect(published.map(envelope => envelope.seq)).toEqual([251])
    expect(redis.set).toHaveBeenCalledWith(`seq:${SESSION}`, 251)
    expect(sessions.raiseSeqHighWater).toHaveBeenCalledWith(SESSION, 350n)
  })

  it('does not open a session whose bound cannot be read', async () => {
    const { service, sessions } = build()
    sessions.findById.mockRejectedValue(new Error('db down'))
    await expect(
      service.open(SESSION, new FakeWhatsAppClient(SESSION), { orderingEnabled: true })
    ).rejects.toThrow('db down')
  })

  it('stops waiting for a database that does not answer', async () => {
    const { service, sessions } = build()
    sessions.findById.mockReturnValue(new Promise(() => undefined))
    const opening = service.open(SESSION, new FakeWhatsAppClient(SESSION), {
      orderingEnabled: true
    })
    const failed = expect(opening).rejects.toMatchObject({ code: 'WHATSAPP_TIMEOUT' })
    await jest.advanceTimersByTimeAsync(5000)
    await failed
  })

  it('keeps publishing when the bound cannot be written', async () => {
    const { service, published, sessions } = build()
    sessions.raiseSeqHighWater.mockRejectedValue(new Error('db down'))
    await service.open(SESSION, new FakeWhatsAppClient(SESSION), { orderingEnabled: true })

    await service.publish(SESSION, 'ping', {})
    await service.publish(SESSION, 'ping', {})

    expect(published.map(envelope => envelope.seq)).toEqual([1, 2])
  })

  it('keeps the count when a session is closed and its last status is published', async () => {
    const { service, published, sessions } = build()
    await service.open(SESSION, new FakeWhatsAppClient(SESSION), { orderingEnabled: true })
    await service.publish(SESSION, 'ping', {})
    await service.close(SESSION)
    await service.publish(SESSION, 'ping', {})

    expect(published.map(envelope => envelope.seq)).toEqual([1, 2])
    expect(sessions.raiseSeqHighWater).toHaveBeenCalledTimes(1)
    expect(sessions.update).not.toHaveBeenCalled()
  })

  it('brings the bound to the last seq at shutdown, after the pipelines flushed', async () => {
    const { service, sessions } = build()
    await service.open(SESSION, new FakeWhatsAppClient(SESSION), { orderingEnabled: true })
    await service.publish(SESSION, 'ping', {})
    await service.publish(SESSION, 'ping', {})

    await service.closeAll()

    expect(sessions.update).toHaveBeenLastCalledWith(SESSION, { seqHighWater: 2n })
  })

  it('forgets the count of a deleted session', async () => {
    const { service, published, sessions } = build()
    await service.publish(SESSION, 'ping', {})
    service.forget(SESSION)
    sessions.findById.mockResolvedValue(null)
    await service.publish(SESSION, 'ping', {})

    // Redis was not touched here, so the mock counter went on: what matters is that the bound is
    // read again from the database
    expect(sessions.findById).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(2)
  })
})
