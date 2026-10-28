import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'

import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { MessagesRepository } from '../database/repositories/messages.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { RedisService } from '../infra/redis/redis.service.js'
import type { MessageDto } from '../types/dto.js'
import type { WaEventName, WaEventPayloadMap } from '../types/events.js'

import { EventBusService } from './event-bus.service.js'
import { ActivityRecorder } from './event-pipeline.activity.js'
import { SeqAllocator } from './event-pipeline.seq-allocator.js'
import { EventSequencer } from './event-pipeline.sequencer.js'
import { SessionEventPipeline } from './event-pipeline.session.js'
import type { WhatsAppClientPort } from './whatsapp-client.port.js'

// How long a message-bearing event is remembered to drop its repeats
const DEDUPE_TTL_S = 600
// Redis commands wait for the connection when it is down (BullMQ needs that), so every command the
// pipeline depends on is bounded: a hung Redis must not stall the stream
const REDIS_TIMEOUT_MS = 5000
// The dedupe runs for every message, one at a time: it gives up sooner than the stamp does
const DEDUPE_TIMEOUT_MS = 1000
const DB_TIMEOUT_MS = 5000
const FETCH_TIMEOUT_MS = 10_000
const REPLAY_DELAY_MS = 5000
const MAX_REPLAY_DELAY_MS = 60_000

export interface OpenSessionOptions {
  // `settings.ordering.enabled` of the session; INBOUND_ORDERING_ENABLED can still turn it off
  orderingEnabled: boolean
}

// dedupe → store → order → stamp `seq` → publish, for every event of every session (TDD §6.4).
// The session manager opens a session's pipeline when its client starts and closes it when it
// stops. Events that do not come from a client (session_status, message_sent, ...) are published
// with `publish`, so one `seq` counter orders everything a session emits.
@Injectable()
export class EventPipelineService implements OnApplicationShutdown {
  private readonly pipelines = new Map<string, SessionEventPipeline>()
  private readonly sequencer: EventSequencer
  private readonly seqAllocator: SeqAllocator
  private readonly activity: ActivityRecorder

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(MessagesRepository) private readonly messages: MessagesRepository,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(EventBusService) bus: EventBusService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {
    this.seqAllocator = new SeqAllocator({
      increment: sessionId => this.incrementSeq(sessionId),
      set: (sessionId, value) => this.setSeq(sessionId, value),
      loadReserved: sessionId => this.loadReservedSeq(sessionId),
      raiseReserved: (sessionId, value) => this.raiseReservedSeq(sessionId, value),
      setReserved: (sessionId, value) => this.setReservedSeq(sessionId, value)
    })
    this.activity = new ActivityRecorder({
      save: (sessionId, at) => this.saveActivity(sessionId, at)
    })
    this.sequencer = new EventSequencer({
      nextSeq: sessionId => this.seqAllocator.next(sessionId),
      publish: envelope => bus.publish(envelope)
    })
  }

  // Starts the pipeline of a session on its client; the one it had before is closed first. A new
  // buffer on every start, since closing a buffer is permanent. The pipeline listens once this
  // resolves, so the caller awaits it before it initializes the client: an event emitted earlier
  // is not seen. Rejects when the reserved `seq` bound of the session cannot be read.
  async open(
    sessionId: string,
    client: Pick<WhatsAppClientPort, 'onEvent' | 'fetchMessages'>,
    options: OpenSessionOptions
  ): Promise<void> {
    await this.seqAllocator.open(sessionId)
    const previous = this.pipelines.get(sessionId)
    const pipeline = new SessionEventPipeline(
      {
        sessionId,
        orderingEnabled: this.config.INBOUND_ORDERING_ENABLED && options.orderingEnabled,
        order: {
          lateThresholdS: this.config.INBOUND_LATE_THRESHOLD_S,
          windowMs: this.config.INBOUND_ORDER_WINDOW_MS,
          maxHoldMs: this.config.INBOUND_ORDER_MAX_HOLD_MS,
          maxMessages: this.config.INBOUND_ORDER_MAX_MESSAGES
        },
        storeBodies: this.config.STORE_MESSAGE_BODIES,
        replayDelayMs: REPLAY_DELAY_MS,
        maxReplayDelayMs: MAX_REPLAY_DELAY_MS,
        fetchTimeoutMs: FETCH_TIMEOUT_MS
      },
      {
        client,
        messages: this.messages,
        sequencer: this.sequencer,
        claim: key => this.claim(key),
        unclaim: key => this.unclaim(key),
        noteIncoming: sentAt => this.activity.note(sessionId, sentAt.getTime()),
        metrics: this.metrics.metrics
      }
    )
    // Registered before the first await, so a second open of the session finds this one and closes it
    this.pipelines.set(sessionId, pipeline)
    await previous?.close()
    pipeline.start()
  }

  async close(sessionId: string): Promise<void> {
    const pipeline = this.pipelines.get(sessionId)
    if (!pipeline) return
    this.pipelines.delete(sessionId)
    await pipeline.close()
    await this.activity.flush(sessionId)
  }

  // Hands the reconciliation's finds to the session's pipeline (see SessionEventPipeline.reconcile).
  // Zero when the session has none open.
  async reconcile(sessionId: string, messages: MessageDto[]): Promise<number> {
    return (await this.pipelines.get(sessionId)?.reconcile(messages)) ?? 0
  }

  // The session was deleted: its count starts from zero if the id is used again
  forget(sessionId: string): void {
    this.seqAllocator.forget(sessionId)
    this.activity.forget(sessionId)
  }

  // An event the gateway makes up. It gets the next `seq` of the session, behind everything the
  // session already has in flight. Rejects when `seq` cannot be assigned (Redis down).
  publish<E extends WaEventName>(
    sessionId: string,
    event: E,
    data: WaEventPayloadMap[E]
  ): Promise<void> {
    return this.sequencer.publish(sessionId, event, data)
  }

  // Closes every pipeline, then brings the `seq` bounds to the last numbers delivered. The session
  // manager calls it from `beforeApplicationShutdown`, once its sessions are down and while
  // Postgres and Redis are still open; the hook below only makes sure it ran.
  async closeAll(): Promise<void> {
    await Promise.all([...this.pipelines.keys()].map(sessionId => this.close(sessionId)))
    await this.seqAllocator.flushAll()
  }

  onApplicationShutdown(): Promise<void> {
    return this.closeAll()
  }

  private async incrementSeq(sessionId: string): Promise<number> {
    this.requireRedis()
    return withTimeout(this.redis.client.incr(`seq:${sessionId}`), REDIS_TIMEOUT_MS, 'redis incr')
  }

  private async setSeq(sessionId: string, value: number): Promise<void> {
    this.requireRedis()
    await withTimeout(
      this.redis.client.set(`seq:${sessionId}`, value),
      REDIS_TIMEOUT_MS,
      'redis set'
    )
  }

  private async loadReservedSeq(sessionId: string): Promise<number> {
    const row = await withTimeout(this.sessions.findById(sessionId), DB_TIMEOUT_MS, 'seq load')
    return Number(row?.seqHighWater ?? 0)
  }

  private async raiseReservedSeq(sessionId: string, value: number): Promise<void> {
    await withTimeout(
      this.sessions.raiseSeqHighWater(sessionId, BigInt(value)),
      DB_TIMEOUT_MS,
      'seq save'
    )
  }

  private async setReservedSeq(sessionId: string, value: number): Promise<void> {
    await withTimeout(
      this.sessions.update(sessionId, { seqHighWater: BigInt(value) }),
      DB_TIMEOUT_MS,
      'seq save'
    )
  }

  private async saveActivity(sessionId: string, at: Date): Promise<void> {
    await withTimeout(
      this.sessions.update(sessionId, { lastEventAt: at }),
      DB_TIMEOUT_MS,
      'activity save'
    )
  }

  private async claim(key: string): Promise<boolean> {
    this.requireRedis()
    const reply = await withTimeout(
      this.redis.client.set(key, '1', 'EX', DEDUPE_TTL_S, 'NX'),
      DEDUPE_TIMEOUT_MS,
      'redis set'
    )
    return reply === 'OK'
  }

  private async unclaim(key: string): Promise<void> {
    this.requireRedis()
    await withTimeout(this.redis.client.del(key), DEDUPE_TIMEOUT_MS, 'redis del')
  }

  // While the connection is down the commands would wait in ioredis' offline queue until the
  // timeout. Failing at once keeps the stream moving: the dedupe is skipped and the publish is
  // replayed later.
  private requireRedis(): void {
    if (this.redis.client.status !== 'ready') throw new Error('redis is not connected')
  }
}
