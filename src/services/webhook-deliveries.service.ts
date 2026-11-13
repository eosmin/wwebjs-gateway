import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'

import {
  InternalError,
  NotFoundError,
  ServiceBusyError,
  ValidationError
} from '../common/errors.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Webhook, WebhookDelivery } from '../database/models.js'
import type { DeliveryCursor } from '../database/repositories/deliveries.repository.js'
import { DeliveriesRepository } from '../database/repositories/deliveries.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type {
  DeliveryDto,
  DeliveryListDto,
  DeliveryListQueryDto,
  RetriedDeliveriesDto,
  TestWebhookBodyDto
} from '../types/webhooks.dto.js'

import { DeliveryEnvelope, DeliveryQueueService } from './delivery-queue.service.js'
import { REDACTED_EVENTS } from './webhook-payload.js'

// Dead letters one retry-failed call puts back: a receiver that was down for a day can leave
// thousands, and the call must not hold the request (and the queue) for all of them
export const RETRY_FAILED_LIMIT = 500
const RETRY_PAGE_SIZE = 100

// A ping is not an event of the session: it has no place in its sequence, and the processor signs
// and sends it like any other. Real events start at 1, so a receiver that drops what it has seen
// (`seq` at or below the last) never takes a ping for a real event, nor a real event for the ping.
const PING_SEQ = 0

const NOT_QUEUED = 'The delivery could not be queued'

const PING_WINDOW_MS = 60_000
// Past this many webhooks in the table of pings, the ones that have not been pinged for a window go
const PING_TABLE_SWEEP_AT = 256

const CursorPayload = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() })

const encodeCursor = (row: WebhookDelivery): string =>
  Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString(
    'base64url'
  )

function decodeCursor(cursor: string): DeliveryCursor {
  const invalid = new ValidationError('VALIDATION_ERROR', 'The cursor is not valid')
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid
  }
  const parsed = CursorPayload.safeParse(json)
  if (!parsed.success) throw invalid
  return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id }
}

export function toDeliveryDto(row: WebhookDelivery): DeliveryDto {
  return {
    id: row.id,
    webhookId: row.webhookId,
    sessionId: row.sessionId,
    event: row.event,
    // The column is a bigint; a session would need 2^53 events to leave the safe range
    seq: Number(row.seq),
    status: row.status,
    attempts: row.attempts,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null
  }
}

// The deliveries of a webhook: the ping, the list, and putting dead letters back in the queue.
// Who may touch the webhook is decided before, by the caller; the dispatcher (7.3) and the
// processor (7.4) share the queue and the table with this service.
@Injectable()
export class WebhookDeliveriesService {
  private readonly logger = new Logger(WebhookDeliveriesService.name)

  // When each webhook was last pinged, within the window: this is one instance, so memory is enough
  private readonly pings = new Map<string, number[]>()

  constructor(
    @Inject(DeliveriesRepository) private readonly deliveries: DeliveriesRepository,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(DeliveryQueueService) private readonly queue: DeliveryQueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  // A `ping` delivery through the whole path, so the receiver, the signature and the SSRF check
  // are tried for real. It is a delivery like the others: it shows in the list and can be retried.
  async test(webhook: Webhook, body: TestWebhookBodyDto): Promise<DeliveryDto> {
    const sessionId = await this.pingSession(webhook, body.sessionId)
    const at = this.takePing(webhook.id)
    const envelope: DeliveryEnvelope = {
      id: `evt_${randomUUID()}`,
      event: 'ping',
      sessionId,
      seq: PING_SEQ,
      timestamp: new Date().toISOString(),
      data: {}
    }
    try {
      const row = await this.deliveries.create({
        webhookId: webhook.id,
        sessionId,
        event: envelope.event,
        seq: BigInt(envelope.seq),
        payload: envelope
      })
      await this.enqueue(row, envelope)
      return toDeliveryDto(row)
    } catch (error: unknown) {
      // Nothing was sent: a failure of the database or the queue must not use up the allowance
      this.refundPing(webhook.id, at)
      throw error
    }
  }

  // A ping is a request to the URL of the webhook whenever the caller asks, so the number of them
  // per webhook is bounded: a key could otherwise send a stream of POSTs to a third party, or probe
  // an internal host the operator allowed for webhooks (the deliveries show the status of each)
  private takePing(webhookId: string): number {
    const now = Date.now()
    const recent = (this.pings.get(webhookId) ?? []).filter(at => now - at < PING_WINDOW_MS)
    const oldest = recent[0]
    if (oldest !== undefined && recent.length >= this.config.WEBHOOK_TEST_MAX_PER_MINUTE) {
      this.pings.set(webhookId, recent)
      throw new ServiceBusyError(
        'RATE_LIMITED',
        Math.ceil((oldest + PING_WINDOW_MS - now) / 1000),
        true,
        `A webhook can be pinged ${this.config.WEBHOOK_TEST_MAX_PER_MINUTE} times a minute`
      )
    }
    this.pings.set(webhookId, [...recent, now])
    if (this.pings.size > PING_TABLE_SWEEP_AT) this.sweepPings(now)
    return now
  }

  private refundPing(webhookId: string, at: number): void {
    const times = this.pings.get(webhookId)
    if (times === undefined) return
    const index = times.lastIndexOf(at)
    if (index >= 0) times.splice(index, 1)
  }

  private sweepPings(now: number): void {
    for (const [id, times] of this.pings) {
      if (times.every(at => now - at >= PING_WINDOW_MS)) this.pings.delete(id)
    }
  }

  // Newest first, a page at a time: the cursor is the last delivery of the previous page
  async list(webhookId: string, query: DeliveryListQueryDto): Promise<DeliveryListDto> {
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
    // One more than asked: its existence is what tells there is another page
    const rows = await this.deliveries.listForWebhook(webhookId, {
      status: query.status,
      limit: query.limit + 1,
      before
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toDeliveryDto),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null
    }
  }

  // Only a dead letter goes back: a delivered one is never sent twice, and one still pending is
  // already on its way
  async retry(webhookId: string, deliveryId: string): Promise<DeliveryDto> {
    const delivery = await this.deliveries.findById(deliveryId)
    if (delivery?.webhookId !== webhookId) {
      throw new NotFoundError('NOT_FOUND', `Delivery "${deliveryId}" does not exist`)
    }
    if (REDACTED_EVENTS.includes(delivery.event)) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        `A "${delivery.event}" delivery cannot be retried: the gateway keeps it without its credential, which expires within a minute`
      )
    }
    const requeued = await this.requeue(delivery)
    if (requeued === null) {
      throw new NotFoundError(
        'NOT_FOUND',
        `Delivery "${deliveryId}" is not a dead letter: only a failed delivery can be retried`
      )
    }
    return toDeliveryDto(requeued)
  }

  // The dead letters of the webhook, up to RETRY_FAILED_LIMIT per call. Each one is claimed
  // atomically, so two calls at once queue every delivery once.
  async retryFailed(webhookId: string): Promise<RetriedDeliveriesDto> {
    let retried = 0
    let before: DeliveryCursor | undefined
    for (;;) {
      const room = RETRY_FAILED_LIMIT - retried
      const page = await this.deliveries.listForWebhook(webhookId, {
        status: 'failed',
        limit: Math.min(RETRY_PAGE_SIZE, Math.max(room, 1)),
        before
      })
      const last = page.at(-1)
      if (last === undefined) return { retried, more: false }
      for (const delivery of page) {
        if (retried === RETRY_FAILED_LIMIT) return { retried, more: true }
        // Nothing to send again: they stay dead letters until the retention removes them
        if (REDACTED_EVENTS.includes(delivery.event)) continue
        if (!DeliveryEnvelope.safeParse(delivery.payload).success) {
          // One row nobody can read must not hold the rest back; it stays a dead letter
          this.logger.warn(`Delivery ${delivery.id} has an unreadable payload and was not retried`)
          continue
        }
        if ((await this.requeue(delivery)) !== null) retried += 1
      }
      before = { createdAt: last.createdAt, id: last.id }
    }
  }

  // A webhook of one session pings as that session; one of every session needs the caller to say
  private async pingSession(webhook: Webhook, requested: string | undefined): Promise<string> {
    if (webhook.sessionId !== null) {
      if (requested !== undefined && requested !== webhook.sessionId) {
        throw new ValidationError(
          'VALIDATION_ERROR',
          `The webhook belongs to session "${webhook.sessionId}"`
        )
      }
      return webhook.sessionId
    }
    if (requested === undefined) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        'The webhook listens to every session: say which one the ping comes from with `sessionId`'
      )
    }
    if ((await this.sessions.findById(requested)) === null) {
      throw new NotFoundError('NOT_FOUND', `Session "${requested}" does not exist`)
    }
    return requested
  }

  // The delivery goes back to pending first, which only one caller can do, and then to the queue.
  // Null when it is not a dead letter (anymore).
  private async requeue(delivery: WebhookDelivery): Promise<WebhookDelivery | null> {
    const envelope = DeliveryEnvelope.safeParse(delivery.payload)
    if (!envelope.success) {
      // Checked before anything changes: the delivery stays a dead letter
      throw new InternalError(
        'INTERNAL',
        `The stored payload of delivery "${delivery.id}" is not an event`
      )
    }
    const reset = await this.deliveries.resetForRetry(delivery.id)
    if (reset === null) return null
    await this.enqueue(reset, envelope.data)
    return reset
  }

  // A job that never reached the queue must not leave the delivery pending with nothing to run it
  private async enqueue(row: WebhookDelivery, envelope: DeliveryEnvelope): Promise<void> {
    try {
      await this.queue.enqueue({ deliveryId: row.id, webhookId: row.webhookId, envelope })
    } catch (error: unknown) {
      await this.deliveries.failUnqueued(row.id, NOT_QUEUED)
      throw error
    }
  }
}
