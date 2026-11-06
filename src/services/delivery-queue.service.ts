import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { type JobType, Queue } from 'bullmq'
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

// What a job returns when it finishes: the only record, once the row could not be written, that the
// receiver answered 2xx. Just these literals: never the URL, the secret, the signature or the payload.
export const DELIVERY_OUTCOMES = ['delivered', 'dropped'] as const
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number]

const COMPLETED_KEPT_SECONDS = 3600
const FAILED_KEPT_SECONDS = 86400
// A QR or a pairing code in a finished job is a credential for about a minute: it is not kept for a day
const CREDENTIAL_KEPT_SECONDS = 300

// What the queue still holds of a delivery: a job that will run (or runs), one that finished
// having sent it (`delivered`), one that finished without sending or without saying (`completed`),
// or one that gave up. A live job outranks the finished ones of the same delivery, because a manual
// retry queues a new job while the failed one it follows is kept; `delivered` outranks `completed`
// because one job that reached the receiver is enough.
export type DeliveryJobState = 'live' | 'delivered' | 'completed' | 'failed'

const LIVE_STATES: JobType[] = ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']
const STATE_GROUPS: readonly (readonly [JobType[], DeliveryJobState])[] = [
  [LIVE_STATES, 'live'],
  [['completed'], 'completed'],
  [['failed'], 'failed']
]
const PAGE_SIZE = 500

// Anything but the exact literal (no result, an older job, a value this code does not know) is
// read as a finished job that said nothing
const finishedState = (state: DeliveryJobState, returned: unknown): DeliveryJobState =>
  state === 'completed' && returned === 'delivered' ? 'delivered' : state

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

  // The state of the job of every delivery the queue holds, by delivery id. It reads all the jobs
  // (a day of failed ones at most), so it is for the sweep of stale rows, not for a request. Its
  // cost is the one of reading the jobs with their data; the result of a finished job is in the
  // same record, so telling `delivered` from `completed` costs nothing more. A finished job is kept
  // an hour: after that its delivery has no job here.
  async jobStates(): Promise<Map<string, DeliveryJobState>> {
    const queue = this.open()
    const states = new Map<string, DeliveryJobState>()
    for (const [types, state] of STATE_GROUPS) {
      for (let start = 0; ; start += PAGE_SIZE) {
        const jobs = await queue.getJobs(types, start, start + PAGE_SIZE - 1)
        for (const job of jobs) {
          const parsed = DeliveryJobData.safeParse(job.data)
          if (!parsed.success) continue
          const { deliveryId } = parsed.data
          const seen = states.get(deliveryId)
          // The groups run from the strongest state down, so only a delivery not seen yet is added;
          // among finished jobs one that delivered replaces one that did not
          if (seen === undefined) {
            states.set(deliveryId, finishedState(state, job.returnvalue))
          } else if (
            seen === 'completed' &&
            finishedState(state, job.returnvalue) === 'delivered'
          ) {
            states.set(deliveryId, 'delivered')
          }
        }
        if (jobs.length < PAGE_SIZE) break
      }
    }
    return states
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
