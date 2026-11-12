import { performance } from 'node:perf_hooks'

import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { type Job, UnrecoverableError, Worker } from 'bullmq'

import { NotFoundError, ValidationError } from '../common/errors.js'
import { signWebhook } from '../common/lib/crypto.js'
import { readPackageInfo } from '../common/lib/package-info.js'
import { RequestFailedError, postToPublicUrl } from '../common/lib/public-post.js'
import { retry } from '../common/lib/retry.js'
import type { SsrfPolicy } from '../common/lib/ssrf.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { isTransientDbError } from '../database/db-errors.js'
import type { Webhook, WebhookDelivery } from '../database/models.js'
import {
  type DeliveryAttempt,
  DeliveriesRepository
} from '../database/repositories/deliveries.repository.js'
import { REDACTED } from '../infra/logger/redaction.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { closeWorker } from '../infra/redis/bullmq-close.js'
import { RedisService } from '../infra/redis/redis.service.js'

import {
  DELIVERY_QUEUE_NAME,
  DeliveryJobData,
  type DeliveryOutcome
} from './delivery-queue.service.js'
import { REDACTED_EVENTS } from './webhook-payload.js'
import { WebhookService } from './webhook.service.js'

// The attempt failed and BullMQ should try again (or, on the last one, give the job up). Its
// message is what the row keeps as `lastError`, so it is written to be shown.
export class DeliveryAttemptFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryAttemptFailed'
  }
}

// What the processor reads of a BullMQ job: the tests hand it exactly this
export type DeliveryJob = Pick<Job, 'data' | 'attemptsMade' | 'opts'>

const MIN_LOCK_MS = 30_000
// The lock covers the address check (5 s), the request and the write of the row, and BullMQ renews
// it while the job runs; this is the margin before a job counts as stalled
const LOCK_MARGIN_MS = 20_000
const CLOSE_TIMEOUT_MS = 30_000
const PING_EVENT = 'ping'
// The write of an attempt is tried this many times in all, with a short, jittered pause between them
// (up to 100 ms, then up to 200 ms; the 400 ms cap is never reached with three tries): the job
// closes within about 300 ms of waiting at most
const RECORD_ATTEMPTS = 3
const RECORD_BACKOFF_MS = 100
const RECORD_BACKOFF_MAX_MS = 400

const DISABLED = 'The webhook is disabled'
const NO_CREDENTIAL = 'The event is stored without its credential and cannot be sent again'
const NOT_COMPLETED = 'The delivery could not be completed'

const isSuccess = (statusCode: number): boolean => statusCode >= 200 && statusCode < 300

// The stored copy of a qr or a pairing code is `{ qr: '[Redacted]' }` or `{ code: '[Redacted]' }`
function carriesRedactedCredential(event: string, data: unknown): boolean {
  if (!REDACTED_EVENTS.includes(event)) return false
  return typeof data === 'object' && data !== null && Object.values(data).includes(REDACTED)
}

// Sends the deliveries of the queue (TDD §6.9): one POST per attempt, signed with the secret the
// webhook has at that moment, to the URL it has at that moment, after the address check has run
// again. Every attempt reads the webhook, so a rotated secret or a changed URL applies to the
// deliveries that are waiting for a retry.
//
// Delivery is at least once: a process that dies after the receiver answered and before the row was
// written sends the job again. The receiver tells the repeat by `X-Gateway-Delivery`, which is the
// same on every attempt of a delivery.
//
// What an attempt may put in the row or in the log is fixed here: the kind of failure and the HTTP
// status. Never the URL (its path can be a secret), the secret, the signature or the payload.
@Injectable()
export class DeliveryProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryProcessor.name)
  private readonly userAgent = `wwebjs-gateway/${readPackageInfo().gatewayVersion}`
  private worker: Worker | undefined

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(WebhookService) private readonly webhooks: WebhookService,
    @Inject(DeliveriesRepository) private readonly deliveries: DeliveriesRepository,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  onModuleInit(): void {
    if (this.config.ALLOW_PRIVATE_WEBHOOK_TARGETS) {
      this.logger.warn(
        'ALLOW_PRIVATE_WEBHOOK_TARGETS is on: webhooks may point at private and loopback addresses. Development only.'
      )
    }
    const worker = new Worker(DELIVERY_QUEUE_NAME, job => this.process(job), {
      connection: this.redis.client,
      concurrency: this.config.WEBHOOK_WORKER_CONCURRENCY,
      lockDuration: Math.max(MIN_LOCK_MS, this.config.WEBHOOK_TIMEOUT_MS + LOCK_MARGIN_MS)
    })
    // Backstop for what the attempt itself could not record (the database was down, the job stalled
    // too often): a job that BullMQ gives up must not leave its delivery pending for ever
    worker.on('failed', (job, error) => {
      void this.onFailed(job, error)
    })
    // Without a listener an error of the connection would be thrown as an uncaught exception
    worker.on('error', error => {
      this.logger.error(`Delivery worker error: ${error.message}`)
    })
    this.worker = worker
  }

  // Before Redis closes. close() waits for the attempts in hand; one stuck must not hold the shutdown.
  async onModuleDestroy(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker === undefined) return
    await closeWorker(worker, this.redis.client, CLOSE_TIMEOUT_MS, 'delivery worker close')
  }

  // One attempt. Resolves when there is nothing more to do for the job and throws to have BullMQ
  // retry it. What it resolves with is kept by BullMQ as the result of the job and is how the sweep
  // of stale rows learns, when the row could not be written, whether the receiver has the event:
  // `delivered` (it answered 2xx) or `dropped` (the job ended without an attempt). Only that literal.
  async process(job: DeliveryJob): Promise<DeliveryOutcome> {
    const parsed = DeliveryJobData.safeParse(job.data)
    // Retrying a job that is not a delivery would only fail again
    if (!parsed.success) throw new UnrecoverableError('The job is not a delivery')
    const { deliveryId, webhookId, envelope } = parsed.data

    const webhook = await this.readWebhook(webhookId)
    if (webhook === undefined) {
      this.drop(deliveryId, 'its webhook no longer exists')
      return 'dropped'
    }
    const row = await this.readDelivery(deliveryId)
    if (row !== undefined && row.webhookId !== webhookId) {
      this.drop(deliveryId, 'the delivery belongs to another webhook')
      return 'dropped'
    }
    if (row?.status === 'success') {
      this.drop(deliveryId, 'it was already delivered')
      return 'dropped'
    }
    // A disabled webhook receives nothing, but a ping: that is how a receiver is checked before it
    // is turned on. The delivery goes to the dead letters, so `retry-failed` sends it once enabled.
    if (!webhook.enabled && envelope.event !== PING_EVENT) {
      await this.giveUp(deliveryId, DISABLED)
      return 'dropped'
    }
    if (carriesRedactedCredential(envelope.event, envelope.data)) {
      await this.giveUp(deliveryId, NO_CREDENTIAL)
      return 'dropped'
    }

    const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
    const outcome = await this.send(webhook, deliveryId, envelope)
    if (outcome.delivered) {
      // The receiver has it: a row that cannot be written must not make the job run again
      await this.record(deliveryId, { status: 'success', statusCode: outcome.statusCode })
      this.metrics.metrics.webhookDeliveries.inc({ result: 'success' })
      return 'delivered'
    }
    await this.record(deliveryId, {
      status: last ? 'failed' : 'pending',
      statusCode: outcome.statusCode,
      error: outcome.error
    })
    this.metrics.metrics.webhookDeliveries.inc({ result: last ? 'failed' : 'retry' })
    this.logger.warn(
      `Delivery ${deliveryId} to webhook ${webhookId} failed (${envelope.event}, attempt ${job.attemptsMade + 1}${last ? ', the last' : ''}): ${outcome.error}`
    )
    throw new DeliveryAttemptFailed(outcome.error)
  }

  private async send(
    webhook: Webhook,
    deliveryId: string,
    envelope: DeliveryJobData['envelope']
  ): Promise<
    | { delivered: true; statusCode: number }
    | { delivered: false; statusCode: number | null; error: string }
  > {
    // The body is built once: the bytes that are signed are the bytes that are sent
    const body = JSON.stringify(envelope)
    const timestamp = Math.floor(Date.now() / 1000)
    const startedAt = performance.now()
    try {
      const { statusCode } = await postToPublicUrl(webhook.url, {
        policy: this.policy(),
        headers: {
          'content-type': 'application/json',
          'user-agent': this.userAgent,
          'x-gateway-event': envelope.event,
          'x-gateway-delivery': deliveryId,
          'x-gateway-seq': String(envelope.seq),
          'x-gateway-timestamp': String(timestamp),
          'x-gateway-signature': signWebhook(webhook.secret, timestamp, body)
        },
        body,
        timeoutMs: this.config.WEBHOOK_TIMEOUT_MS
      })
      return isSuccess(statusCode)
        ? { delivered: true, statusCode }
        : { delivered: false, statusCode, error: `The receiver answered ${statusCode}` }
    } catch (error: unknown) {
      return { delivered: false, statusCode: null, error: this.describe(error) }
    } finally {
      this.metrics.metrics.webhookDurationSeconds.observe((performance.now() - startedAt) / 1000)
    }
  }

  // The failures the gateway knows carry a message made to be stored; anything else is a bug and
  // only its class is logged, because the message of an unknown error can echo the URL or the body
  private describe(error: unknown): string {
    if (error instanceof RequestFailedError || error instanceof ValidationError)
      return error.message
    this.logger.error(`Unexpected error while sending a delivery: ${errorKind(error)}`)
    return 'The delivery could not be sent'
  }

  private policy(): SsrfPolicy {
    return {
      privateHostAllowlist: this.config.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
      allowPrivate: this.config.ALLOW_PRIVATE_WEBHOOK_TARGETS
    }
  }

  // Undefined when the webhook is gone. Any other failure (the database) is thrown: the attempt
  // counts and BullMQ tries again.
  private async readWebhook(id: string): Promise<Webhook | undefined> {
    try {
      return await this.webhooks.require(id)
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return undefined
      throw error
    }
  }

  // Undefined when the row is not there (it could not be stored) or cannot be read: that does not
  // stop the delivery, because the receiver must not miss an event for the sake of the log
  private async readDelivery(deliveryId: string): Promise<WebhookDelivery | undefined> {
    try {
      return (await this.deliveries.findById(deliveryId)) ?? undefined
    } catch {
      return undefined
    }
  }

  private drop(deliveryId: string, reason: string): void {
    this.metrics.metrics.webhookDeliveries.inc({ result: 'dropped' })
    this.logger.log(`Delivery ${deliveryId} dropped: ${reason}`)
  }

  // The job ends without an attempt, and the delivery is left where `retry` can pick it up
  private async giveUp(deliveryId: string, reason: string): Promise<void> {
    this.drop(deliveryId, reason.toLowerCase())
    try {
      await this.deliveries.failUnqueued(deliveryId, reason)
    } catch (error: unknown) {
      this.logger.error(`Delivery ${deliveryId} could not be marked failed: ${errorKind(error)}`)
    }
  }

  // Writes the result of an attempt, again after a failure of the database that waiting can cure.
  // It never throws: the receiver has the event (or the attempt is already counted by the queue), so
  // a row that cannot be written must not make the job run again.
  private async record(deliveryId: string, attempt: DeliveryAttempt): Promise<void> {
    try {
      await retry(() => this.deliveries.recordAttempt(deliveryId, attempt, new Date()), {
        attempts: RECORD_ATTEMPTS,
        baseDelayMs: RECORD_BACKOFF_MS,
        maxDelayMs: RECORD_BACKOFF_MAX_MS,
        shouldRetry: isTransientDbError
      })
    } catch (error: unknown) {
      this.logger.error(
        `The attempt of delivery ${deliveryId} could not be recorded: ${errorKind(error)}`
      )
    }
  }

  private async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (job === undefined) return
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return
    const parsed = DeliveryJobData.safeParse(job.data)
    if (!parsed.success) return
    this.logger.warn(
      `Delivery ${parsed.data.deliveryId} was given up by the queue: ${errorKind(error)}`
    )
    try {
      // Only a delivery still pending changes: one the last attempt already recorded stays as it is
      await this.deliveries.failUnqueued(parsed.data.deliveryId, NOT_COMPLETED)
    } catch (failure: unknown) {
      this.logger.error(
        `Delivery ${parsed.data.deliveryId} could not be marked failed: ${errorKind(failure)}`
      )
    }
  }
}

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error)
