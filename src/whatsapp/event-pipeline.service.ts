import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'

import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { MessagesRepository } from '../database/repositories/messages.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { RedisService } from '../infra/redis/redis.service.js'
import type { WaEventName, WaEventPayloadMap } from '../types/events.js'

import { EventBusService } from './event-bus.service.js'
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
  private readonly sessions = new Map<string, SessionEventPipeline>()
  private readonly sequencer: EventSequencer

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(MessagesRepository) private readonly messages: MessagesRepository,
    @Inject(EventBusService) bus: EventBusService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {
    this.sequencer = new EventSequencer({
      nextSeq: sessionId => this.nextSeq(sessionId),
      publish: envelope => bus.publish(envelope)
    })
  }

  // Starts the pipeline of a session on its client; the one it had before is closed first. A new
  // buffer on every start, since closing a buffer is permanent. The pipeline listens once this
  // resolves, so the caller awaits it before it initializes the client: an event emitted earlier
  // is not seen.
  async open(
    sessionId: string,
    client: Pick<WhatsAppClientPort, 'onEvent' | 'fetchMessages'>,
    options: OpenSessionOptions
  ): Promise<void> {
    const previous = this.sessions.get(sessionId)
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
        metrics: this.metrics.metrics
      }
    )
    // Registered before the first await, so a second open of the session finds this one and closes it
    this.sessions.set(sessionId, pipeline)
    await previous?.close()
    pipeline.start()
  }

  async close(sessionId: string): Promise<void> {
    const pipeline = this.sessions.get(sessionId)
    if (!pipeline) return
    this.sessions.delete(sessionId)
    await pipeline.close()
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

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(sessionId => this.close(sessionId)))
  }

  private async nextSeq(sessionId: string): Promise<number> {
    this.requireRedis()
    return withTimeout(this.redis.client.incr(`seq:${sessionId}`), REDIS_TIMEOUT_MS, 'redis incr')
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
