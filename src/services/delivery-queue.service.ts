import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { Queue } from 'bullmq'
import { z } from 'zod'

import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { RedisService } from '../infra/redis/redis.service.js'

import { REDACTED_EVENTS } from './webhook-payload.js'

// One queue for every webhook: the retries of a delivery are BullMQ attempts of one job, and a
// receiver that is down only slows its own deliveries down, not the sends (those have lanes of their own)
export const DELIVERY_QUEUE_NAME = 'webhook-deliveries'
export const DELIVER_JOB_NAME = 'deliver'

// The event as it is POSTed. The job carries all of it (Redis persists it); the copy in the
// database is the redacted one a manual retry starts from.
export const DeliveryEnvelope = z.object({
  id: z.string(),
  event: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  timestamp: z.string(),
  data: z.json()
})
export type DeliveryEnvelope = z.infer<typeof DeliveryEnvelope>

// The job names its webhook itself because the delivery row can be missing (the database was down
// when the dispatcher stored it, TDD §6.9) and the job must still reach the right receiver
export const DeliveryJobData = z.object({
  deliveryId: z.string(),
  webhookId: z.string(),
  envelope: DeliveryEnvelope
})
export type DeliveryJobData = z.infer<typeof DeliveryJobData>

const COMPLETED_KEPT_SECONDS = 3600
const FAILED_KEPT_SECONDS = 86400
// A QR or a pairing code in a finished job is a credential for about a minute: it is not kept for a day
const CREDENTIAL_KEPT_SECONDS = 300

// Where the deliveries wait for an attempt (TDD §6.9). The routes (test, retry) and the
// dispatcher put jobs in; the processor takes them out.
@Injectable()
export class DeliveryQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(DeliveryQueueService.name)
  // Opened by the first use, so building the module touches no Redis
  private queue: Queue<DeliveryJobData> | undefined

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService
  ) {}

  // Every enqueue is a new job on purpose: a manual retry of a delivery whose last job is still
  // kept (a failed one stays a day) must not be swallowed as a duplicate of it
  async enqueue(data: DeliveryJobData): Promise<void> {
    const credential = REDACTED_EVENTS.includes(data.envelope.event)
    await this.open().add(DELIVER_JOB_NAME, data, {
      attempts: this.config.WEBHOOK_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: this.config.WEBHOOK_BACKOFF_MS },
      removeOnComplete: { age: credential ? CREDENTIAL_KEPT_SECONDS : COMPLETED_KEPT_SECONDS },
      removeOnFail: { age: credential ? CREDENTIAL_KEPT_SECONDS : FAILED_KEPT_SECONDS }
    })
  }

  // For the queue dashboard (Bull Board): the listener gets the queue once, as the send queue does
  // when its lanes change. Opens the queue, so it is only called when the dashboard is enabled.
  watchQueues(listener: (queues: Queue[]) => void): () => void {
    listener([this.open()])
    return () => undefined
  }

  // Before Redis closes
  async onModuleDestroy(): Promise<void> {
    await this.queue?.close()
    this.queue = undefined
  }

  private open(): Queue<DeliveryJobData> {
    if (this.queue === undefined) {
      this.queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
        connection: this.redis.client
      })
      // Without a listener an error of the connection would be thrown as an uncaught exception
      this.queue.on('error', error => {
        this.logger.error(`Delivery queue error: ${error.message}`)
      })
    }
    return this.queue
  }
}
