import { randomUUID } from 'node:crypto'

import { parseEnv } from '../../src/config/env.schema.js'
import { MetricsService } from '../../src/infra/metrics/metrics.service.js'
import { RedisService } from '../../src/infra/redis/redis.service.js'
import { EventReplayService, streamKey } from '../../src/realtime/event-replay.service.js'
import type { EventEnvelope } from '../../src/types/events.js'
import { EventBusService } from '../../src/whatsapp/event-bus.service.js'
import { REAL_ENV, TEST_ENV } from '../helpers/env.js'

const redisUrl = REAL_ENV.REDIS_URL
if (redisUrl === undefined) throw new Error('REDIS_URL is required by the integration suites')

const envelope = (
  sessionId: string,
  seq: number,
  timestamp: string,
  event: EventEnvelope['event'] = 'message'
): EventEnvelope =>
  ({ id: `evt_${seq}`, event, sessionId, seq, timestamp, data: { id: `m${seq}` } }) as EventEnvelope

// The real Redis: the stream ids, the exclusive range and the trims are Redis behavior a stand-in
// would only repeat back
describe('EventReplayService with a real Redis (integration)', () => {
  let redis: RedisService
  let bus: EventBusService
  let metrics: MetricsService
  let session: string

  const build = (env: Record<string, string> = {}): EventReplayService =>
    new EventReplayService(
      parseEnv({ ...TEST_ENV, REDIS_URL: redisUrl, ...env }),
      redis,
      bus,
      metrics
    )

  beforeEach(() => {
    redis = new RedisService(parseEnv({ ...TEST_ENV, REDIS_URL: redisUrl }))
    bus = new EventBusService()
    metrics = new MetricsService()
    session = `replay-${randomUUID()}`
  })

  afterEach(async () => {
    await redis.client.del(streamKey(session), `seq:${session}`)
    await redis.onApplicationShutdown()
  })

  it('keeps events by seq and reads those after one, oldest first, with a limit and a "more" flag', async () => {
    const replay = build()
    for (const seq of [1, 2, 3, 5, 8]) {
      await replay.record(envelope(session, seq, new Date().toISOString()))
    }

    const after2 = await replay.read(session, 2, 10)
    const limited = await replay.read(session, 0, 2)

    expect(after2.events.map(e => e.seq)).toEqual([3, 5, 8])
    expect(after2.more).toBe(false)
    expect(limited.events.map(e => e.seq)).toEqual([1, 2])
    expect(limited.more).toBe(true)
    expect(after2.events[0]).toMatchObject({ id: 'evt_3', event: 'message', sessionId: session })
  })

  it('never keeps qr or code', async () => {
    const replay = build()

    await replay.record(envelope(session, 1, new Date().toISOString(), 'qr'))
    await replay.record(envelope(session, 2, new Date().toISOString(), 'code'))

    expect(await redis.client.exists(streamKey(session))).toBe(0)
  })

  it('keeps nothing when the window is 0', async () => {
    const replay = build({ EVENT_REPLAY_WINDOW_SECONDS: '0' })

    await replay.record(envelope(session, 1, new Date().toISOString()))

    expect(await redis.client.exists(streamKey(session))).toBe(0)
    expect(await replay.read(session, 0, 10)).toEqual({ events: [], more: false })
  })

  it('bounds the count with EVENT_REPLAY_MAX_EVENTS, dropping the oldest', async () => {
    const replay = build({ EVENT_REPLAY_MAX_EVENTS: '10' })
    for (let seq = 1; seq <= 300; seq += 1) {
      await replay.record(envelope(session, seq, new Date().toISOString()))
    }

    const kept = await replay.read(session, 0, 1000)

    // MAXLEN ~ trims in whole nodes, so it may keep a few more than 10, never all 300
    expect(kept.events.length).toBeLessThan(300)
    expect(kept.events[kept.events.length - 1]?.seq).toBe(300)
  })

  it('starts the stream again when the seq of the session went back (a session created again)', async () => {
    const replay = build()
    await replay.record(envelope(session, 500, new Date().toISOString()))

    await replay.record(envelope(session, 1, new Date().toISOString()))
    await replay.record(envelope(session, 2, new Date().toISOString()))

    expect((await replay.read(session, 0, 10)).events.map(e => e.seq)).toEqual([1, 2])
  })

  it('keeps the stream when the same event is recorded twice, and when an older one arrives out of order', async () => {
    const replay = build()
    await replay.record(envelope(session, 5, new Date().toISOString()))
    await replay.record(envelope(session, 6, new Date().toISOString()))

    await replay.record(envelope(session, 6, new Date().toISOString()))

    expect((await replay.read(session, 0, 10)).events.map(e => e.seq)).toEqual([5, 6])
  })

  it('does not serve an event older than the window even before the sweep removed it', async () => {
    const replay = build({ EVENT_REPLAY_WINDOW_SECONDS: '60' })
    await replay.record(envelope(session, 1, new Date(Date.now() - 600_000).toISOString()))
    await replay.record(envelope(session, 2, new Date().toISOString()))

    expect((await replay.read(session, 0, 10)).events.map(e => e.seq)).toEqual([2])
  })

  it('sweeps what is older than the window and keeps the rest', async () => {
    const replay = build({ EVENT_REPLAY_WINDOW_SECONDS: '300' })
    const now = Date.now()
    const at = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString()
    await replay.record(envelope(session, 1, at(900)))
    await replay.record(envelope(session, 2, at(400)))
    await replay.record(envelope(session, 3, at(100)))
    await replay.record(envelope(session, 4, at(1)))

    await replay.sweep(now)

    expect((await replay.read(session, 0, 10)).events.map(e => e.seq)).toEqual([3, 4])
  })

  it('sweeps a stream whose events are all old, in more than one step', async () => {
    const replay = build({ EVENT_REPLAY_WINDOW_SECONDS: '60' })
    const now = Date.now()
    for (let seq = 1; seq <= 250; seq += 1) {
      await replay.record(envelope(session, seq, new Date(now - 3_600_000).toISOString()))
    }

    await replay.sweep(now)

    expect((await replay.read(session, 0, 10)).events).toEqual([])
  })

  it('gives the last seq of the session from its counter', async () => {
    const replay = build()
    await redis.client.set(`seq:${session}`, '41')

    expect(await replay.lastSeq(session)).toBe(41)
    expect(await replay.lastSeq(`${session}-none`)).toBe(0)
  })

  it('records what the bus publishes once the module started, and not after it stopped', async () => {
    const replay = build()
    replay.onModuleInit()

    bus.publish(envelope(session, 1, new Date().toISOString()))
    await new Promise(resolve => setTimeout(resolve, 100))
    replay.onModuleDestroy()
    bus.publish(envelope(session, 2, new Date().toISOString()))
    await new Promise(resolve => setTimeout(resolve, 100))

    expect((await replay.read(session, 0, 10)).events.map(e => e.seq)).toEqual([1])
  })
})
