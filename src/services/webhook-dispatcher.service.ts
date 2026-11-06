import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'

import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Webhook } from '../database/models.js'
import { DeliveriesRepository } from '../database/repositories/deliveries.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { EventEnvelope } from '../types/events.js'
import { ALL_EVENTS, EventBusService } from '../whatsapp/event-bus.service.js'

import { type DeliveryEnvelope, DeliveryQueueService } from './delivery-queue.service.js'
import { WebhookMediaService } from './webhook-media.service.js'
import { redactForStorage, shapeForWebhook } from './webhook-payload.js'
import { WebhookService } from './webhook.service.js'

const NOT_QUEUED = 'The delivery could not be queued'

// From the event bus to the delivery queue (TDD §6.9): one delivery per enabled webhook that wants
// the event. Deliveries are independent, so a webhook that fails here never holds back another one,
// nor the bus (which does not await its subscribers anyway).
//
// Two failures, two answers, and neither loses an event silently:
// - The row cannot be stored (the database is down): the job is queued all the same, because the
//   receiver must not miss an event for the sake of its log. It carries a delivery id with no row;
//   the processor delivers it and its attempts have nothing to record. Counted as `unlogged`.
// - The job cannot be queued (Redis is down): the row is marked failed, so the delivery shows in the
//   dead letters and `retry` / `retry-failed` can send it from the redacted copy. Counted as
//   `not_queued`. When there is no row either, the event is lost and the error log is all that is left.
@Injectable()
export class WebhookDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcherService.name)
  private stop: (() => void) | undefined

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EventBusService) private readonly bus: EventBusService,
    @Inject(WebhookService) private readonly webhooks: WebhookService,
    @Inject(DeliveriesRepository) private readonly deliveries: DeliveriesRepository,
    @Inject(DeliveryQueueService) private readonly queue: DeliveryQueueService,
    @Inject(WebhookMediaService) private readonly media: WebhookMediaService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  onModuleInit(): void {
    this.stop = this.bus.subscribe(ALL_EVENTS, event => this.dispatch(event))
  }

  onModuleDestroy(): void {
    this.stop?.()
    this.stop = undefined
  }

  // Resolves once every delivery was stored and queued; never rejects
  async dispatch(event: EventEnvelope): Promise<void> {
    let targets: Webhook[]
    try {
      targets = await this.webhooks.forEvent(event.sessionId, event.event)
    } catch (error: unknown) {
      this.fail(event, 'The webhooks could not be read', error)
      return
    }
    // The file is downloaded once, and only when a webhook takes it inline; never rejects. Only
    // the webhooks that take it wait for it.
    const download = targets.some(webhook => webhook.mediaMode === 'inline')
      ? this.media.fetchInline(event)
      : undefined
    await Promise.all(
      targets.map(async webhook =>
        this.deliver(webhook, event, webhook.mediaMode === 'inline' ? await download : undefined)
      )
    )
  }

  private async deliver(
    webhook: Webhook,
    event: EventEnvelope,
    inline: ReadonlyMap<string, string> | undefined
  ): Promise<void> {
    let envelope: DeliveryEnvelope
    try {
      envelope = shapeForWebhook(
        event,
        {
          includeRaw: webhook.includeRaw ?? this.config.INCLUDE_RAW,
          mediaMode: webhook.mediaMode,
          inlineMediaMaxBytes: this.config.WEBHOOK_INLINE_MEDIA_MAX_BYTES
        },
        inline
      )
    } catch (error: unknown) {
      // An event nobody can read must not stop the other webhooks, nor reject: the bus has no one to tell
      this.fail(event, `Delivery to webhook ${webhook.id} could not be built`, error)
      return
    }
    const deliveryId = randomUUID()
    const results = this.metrics.metrics.webhookDeliveries

    let stored = true
    try {
      await this.deliveries.create({
        id: deliveryId,
        webhookId: webhook.id,
        sessionId: event.sessionId,
        event: event.event,
        seq: BigInt(event.seq),
        payload: redactForStorage(envelope)
      })
    } catch (error: unknown) {
      stored = false
      results.inc({ result: 'unlogged' })
      this.fail(event, `Delivery to webhook ${webhook.id} could not be stored`, error)
    }

    try {
      await this.queue.enqueue(
        { deliveryId, webhookId: webhook.id, envelope },
        { inlineMedia: webhook.mediaMode === 'inline' }
      )
    } catch (error: unknown) {
      results.inc({ result: 'not_queued' })
      this.fail(event, `Delivery to webhook ${webhook.id} could not be queued`, error)
      if (stored) await this.markFailed(deliveryId, event)
    }
  }

  private async markFailed(deliveryId: string, event: EventEnvelope): Promise<void> {
    try {
      await this.deliveries.failUnqueued(deliveryId, NOT_QUEUED)
    } catch (error: unknown) {
      this.fail(event, `Delivery ${deliveryId} could not be marked failed`, error)
    }
  }

  // Identifiers and the error class only: the message of an error can echo a URL or the payload
  private fail(event: EventEnvelope, what: string, error: unknown): void {
    const kind = error instanceof Error ? error.name : typeof error
    this.logger.error(
      `${what} (${event.event}, session ${event.sessionId}, seq ${event.seq}): ${kind}`
    )
  }
}
