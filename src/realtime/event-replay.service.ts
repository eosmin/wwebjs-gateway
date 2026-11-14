import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { z } from 'zod'

import { InternalError } from '../common/errors.js'
import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { RedisService } from '../infra/redis/redis.service.js'
import { CREDENTIAL_EVENTS, type EventEnvelope } from '../types/events.js'
import { ALL_EVENTS, EventBusService } from '../whatsapp/event-bus.service.js'

const REDIS_TIMEOUT_MS = 2000
// A hard bound on the size of one kept event: Redis holds it whole, and a socket re-sends it whole
export const REPLAY_MAX_EVENT_BYTES = 256 * 1024
const SWEEP_INTERVAL_MS = 15_000
// Entries read per step of the age sweep, and steps per session per sweep
const SWEEP_BATCH = 100
const SWEEP_MAX_STEPS = 50
const FIELD = 'e'
const ID_NOT_INCREASING = /equal or smaller/i

const StoredEnvelope = z.looseObject({
  id: z.string(),
  event: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  timestamp: z.string(),
  data: z.unknown()
})

export interface ReplayPage {
  events: EventEnvelope[]
  // More events are kept after the last one returned: ask again from its `seq`
  more: boolean
}

// The recent events of each session, kept so that a client that lost its connection can ask for what
// it missed (TDD §6.10). One Redis stream per session, `events:<sessionId>`, whose entry id IS the
// `seq` (`<seq>-0`): `seq` only ever grows, so Redis accepts it as an id and a range read from
// `afterSeq` is a plain XRANGE. The window is enforced by age (EVENT_REPLAY_WINDOW_SECONDS, swept
// from the timestamp of each event) and by count (EVENT_REPLAY_MAX_EVENTS, a MAXLEN on every write),
// so the memory is bounded whatever the traffic.
//
// Writing is best effort: it never blocks nor fails the live fan-out (the bus does not wait for its
// subscribers), and an event that could not be kept only means a client may find it missing from a
// replay, which the `truncated` answer of `replay` tells it to fill from REST. `qr` and `code` are a
// credential and are never kept.
@Injectable()
export class EventReplayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventReplayService.name)
  // Sessions written since the last sweep found their stream empty: the ones the sweep trims
  private readonly active = new Set<string>()
  private stopBus: (() => void) | undefined
  private sweepTimer: NodeJS.Timeout | undefined
  private sweeping = false

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(EventBusService) private readonly bus: EventBusService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return
    this.stopBus = this.bus.subscribe(ALL_EVENTS, envelope => this.record(envelope))
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref()
  }

  onModuleDestroy(): void {
    this.stopBus?.()
    this.stopBus = undefined
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  // A window of 0 turns the replay off
  get enabled(): boolean {
    return this.config.EVENT_REPLAY_WINDOW_SECONDS > 0
  }

  // Resolves once the event is kept or given up on; never rejects
  async record(envelope: EventEnvelope): Promise<void> {
    if (!this.enabled || CREDENTIAL_EVENTS.includes(envelope.event)) return
    try {
      const payload = JSON.stringify(envelope)
      if (Buffer.byteLength(payload) > REPLAY_MAX_EVENT_BYTES) {
        this.fail(envelope, 'the event is over the size limit')
        return
      }
      await this.append(envelope, payload)
      this.active.add(envelope.sessionId)
    } catch (error: unknown) {
      this.fail(envelope, error instanceof Error ? error.name : typeof error)
    }
  }

  // The kept events of a session after `afterSeq`, oldest first, at most `limit`
  async read(sessionId: string, afterSeq: number, limit: number): Promise<ReplayPage> {
    if (!this.enabled) return { events: [], more: false }
    try {
      const rows = await withTimeout(
        this.redis.client.xrange(streamKey(sessionId), `(${afterSeq}-0`, '+', 'COUNT', limit + 1),
        REDIS_TIMEOUT_MS,
        'redis xrange'
      )
      // Older than the window is not served even if the sweep has not reached it (after a restart the
      // sweep knows no session until it writes again)
      const cutoff = Date.now() - this.config.EVENT_REPLAY_WINDOW_SECONDS * 1000
      const events: EventEnvelope[] = []
      for (const [, fields] of rows.slice(0, limit)) {
        const event = parseEntry(fields)
        if (event !== undefined && Date.parse(event.timestamp) >= cutoff) events.push(event)
      }
      return { events, more: rows.length > limit }
    } catch (error: unknown) {
      this.logger.error(`Could not read the replay of a session: ${errorKind(error)}`)
      throw new InternalError('INTERNAL', 'The replay is not available')
    }
  }

  // The last `seq` the session handed out (0 before its first event); for the snapshot and to tell a
  // replay that events existed and are gone
  async lastSeq(sessionId: string): Promise<number> {
    try {
      const value = await withTimeout(
        this.redis.client.get(`seq:${sessionId}`),
        REDIS_TIMEOUT_MS,
        'redis get'
      )
      const seq = Number(value ?? 0)
      return Number.isSafeInteger(seq) && seq >= 0 ? seq : 0
    } catch (error: unknown) {
      this.logger.error(`Could not read the seq of a session: ${errorKind(error)}`)
      throw new InternalError('INTERNAL', 'The sequence of the session is not available')
    }
  }

  private async append(envelope: EventEnvelope, payload: string): Promise<void> {
    const key = streamKey(envelope.sessionId)
    const id = `${envelope.seq}-0`
    const add = (): Promise<string | null> =>
      withTimeout(
        this.redis.client.xadd(
          key,
          'MAXLEN',
          '~',
          this.config.EVENT_REPLAY_MAX_EVENTS,
          id,
          FIELD,
          payload
        ),
        REDIS_TIMEOUT_MS,
        'redis xadd'
      )
    try {
      await add()
    } catch (error: unknown) {
      // A session deleted and created again with the same id counts from 1 again, below what the old
      // stream holds. The old events belong to a session that no longer exists, so they go.
      if (!(error instanceof Error) || !ID_NOT_INCREASING.test(error.message)) throw error
      const top = await this.topSeq(key)
      // The same event again (a redelivery): it is kept already
      if (top === envelope.seq) return
      // Only a counter that went back is a session created again; anything else is not ours to drop
      if (top === undefined || top < envelope.seq) throw error
      await withTimeout(this.redis.client.del(key), REDIS_TIMEOUT_MS, 'redis del')
      await add()
    }
    // A stream nobody writes to any more disappears by itself
    await withTimeout(
      this.redis.client.pexpire(key, this.config.EVENT_REPLAY_WINDOW_SECONDS * 2000),
      REDIS_TIMEOUT_MS,
      'redis pexpire'
    )
  }

  // The `seq` of the newest entry of a stream, undefined when it is empty
  private async topSeq(key: string): Promise<number | undefined> {
    const rows = await withTimeout(
      this.redis.client.xrevrange(key, '+', '-', 'COUNT', 1),
      REDIS_TIMEOUT_MS,
      'redis xrevrange'
    )
    const id = rows[0]?.[0]
    const seq = id === undefined ? Number.NaN : Number(id.split('-')[0])
    return Number.isSafeInteger(seq) ? seq : undefined
  }

  // Drops what is older than the window. The order of `seq` is the order of the events, so the old
  // ones are a prefix of the stream: read from the start until one is young enough.
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const sessionId of [...this.active]) {
        try {
          // Taken out first: a write that lands during the trim adds the session again, and only a
          // stream that is not empty stays in the set
          this.active.delete(sessionId)
          const emptied = await this.trim(
            sessionId,
            now - this.config.EVENT_REPLAY_WINDOW_SECONDS * 1000
          )
          if (!emptied) this.active.add(sessionId)
        } catch (error: unknown) {
          this.logger.warn(`Could not trim the replay of a session: ${errorKind(error)}`)
        }
      }
    } finally {
      this.sweeping = false
    }
  }

  // True when the stream is empty after it
  private async trim(sessionId: string, cutoff: number): Promise<boolean> {
    const key = streamKey(sessionId)
    for (let step = 0; step < SWEEP_MAX_STEPS; step += 1) {
      const rows = await withTimeout(
        this.redis.client.xrange(key, '-', '+', 'COUNT', SWEEP_BATCH),
        REDIS_TIMEOUT_MS,
        'redis xrange'
      )
      if (rows.length === 0) return true
      let firstKept = -1
      for (const [index, [, fields]] of rows.entries()) {
        // An entry that cannot be read is dropped with the old ones, so it cannot stay for ever
        const at = Date.parse(parseEntry(fields)?.timestamp ?? '')
        if (Number.isFinite(at) && at >= cutoff) {
          firstKept = index
          break
        }
      }
      if (firstKept === 0) return false
      const boundary = firstKept === -1 ? undefined : rows[firstKept]?.[0]
      if (boundary !== undefined) {
        await withTimeout(
          this.redis.client.xtrim(key, 'MINID', boundary),
          REDIS_TIMEOUT_MS,
          'redis xtrim'
        )
        return false
      }
      // The whole batch is old: drop it and read on
      const last = rows[rows.length - 1]?.[0]
      if (last === undefined) return true
      await withTimeout(
        this.redis.client.xtrim(key, 'MINID', nextId(last)),
        REDIS_TIMEOUT_MS,
        'redis xtrim'
      )
      if (rows.length < SWEEP_BATCH) return true
    }
    return false
  }

  // The event and the session only: an error message could echo content
  private fail(envelope: EventEnvelope, reason: string): void {
    this.metrics.metrics.replayWriteFailures.inc()
    this.logger.warn(
      `An event was not kept for replay (session ${envelope.sessionId}, seq ${envelope.seq}, ${envelope.event}): ${reason}`
    )
  }
}

export const streamKey = (sessionId: string): string => `events:${sessionId}`

// `1042-0` -> `1043-0`: the first id after one
function nextId(id: string): string {
  const seq = Number(id.split('-')[0])
  return `${seq + 1}-0`
}

function parseEntry(fields: readonly string[]): EventEnvelope | undefined {
  const at = fields.indexOf(FIELD)
  const raw = at === -1 ? undefined : fields[at + 1]
  if (raw === undefined) return undefined
  try {
    const parsed = StoredEnvelope.safeParse(JSON.parse(raw))
    // The writer is this service, which stored a whole envelope; the shape is only re-checked
    return parsed.success ? (parsed.data as unknown as EventEnvelope) : undefined
  } catch {
    return undefined
  }
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
