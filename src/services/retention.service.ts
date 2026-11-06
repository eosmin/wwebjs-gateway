import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq'

import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import {
  type DeliveryCursor,
  DeliveriesRepository
} from '../database/repositories/deliveries.repository.js'
import { IdempotencyRepository } from '../database/repositories/idempotency.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { RedisService } from '../infra/redis/redis.service.js'

import { type DeliveryJobState, DeliveryQueueService } from './delivery-queue.service.js'
import { MessageStoreService } from './message-store.service.js'

export const RETENTION_QUEUE_NAME = 'retention'
export const PURGE_JOB_NAME = 'purge'
export const SWEEP_JOB_NAME = 'sweep-pending'

// Daily, at an hour with little traffic (the server clock)
const PURGE_CRON = '0 3 * * *'
const SWEEP_EVERY_MS = 10 * 60 * 1000
const MS_PER_DAY = 24 * 3600 * 1000
// TDD §6.9: an idempotency key is only worth keeping while a client may still repeat its request
const IDEMPOTENCY_KEPT_MS = MS_PER_DAY
// How long a pending row may go without its job showing in the queue before the sweep takes it.
// Liveness comes from the queue, not from the age: a row whose job is delayed for a retry is never
// touched however old it is. The age only keeps the sweep away from a row the dispatcher has just
// stored and not yet queued (milliseconds), and keeps the job of a delivery whose result could not
// be written (kept an hour once it finishes) in sight of the next runs.
const STALE_PENDING_MS = 30 * 60 * 1000
const PAGE_SIZE = 500
// 10 000 rows per run; the rest waits for the next one, ten minutes later
const MAX_PAGES = 20
const FINISHED_RUNS_KEPT = 10
const FAILED_RUNS_KEPT = 50
const PURGE_ATTEMPTS = 3
const PURGE_BACKOFF_MS = 60_000
const CLOSE_TIMEOUT_MS = 30_000

// What the row keeps as `lastError` when the sweep sends it to the dead letters. They say what the
// gateway knows, and none claims the receiver does not have the event: the sweep cannot tell.
const NO_JOB =
  'The delivery has no job in the queue, so nothing will send it (it may never have been queued)'
const FINISHED_UNRECORDED =
  'The delivery job finished but its outcome was not recorded; the receiver may already have the event'
const EXHAUSTED_UNRECORDED =
  'The queue gave up on the delivery job and its outcome was not recorded; the receiver may already have the event'

const reasonFor = (state: DeliveryJobState | undefined): string => {
  if (state === 'completed') return FINISHED_UNRECORDED
  if (state === 'failed') return EXHAUSTED_UNRECORDED
  return NO_JOB
}

export interface PurgeResult {
  deliveries: number
  messages: number
  idempotencyKeys: number
}

export interface SweepResult {
  // Rows sent to the dead letters
  failed: number
  // Rows older than the margin whose job is still going to run, left as they are
  alive: number
}

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error)

// What the gateway deletes on a schedule (TDD §6.9, §5.3), and the check that no webhook delivery
// stays pending without a job. Both run as BullMQ job schedulers, so they survive a restart and a
// missed run is not repeated twice. The gateway is one instance, so nothing guards two runs at once.
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name)
  private queue: Queue | undefined
  private worker: Worker | undefined

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(DeliveriesRepository) private readonly deliveries: DeliveriesRepository,
    @Inject(IdempotencyRepository) private readonly idempotency: IdempotencyRepository,
    @Inject(MessageStoreService) private readonly messages: MessageStoreService,
    @Inject(DeliveryQueueService) private readonly deliveryQueue: DeliveryQueueService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = this.redis.client
    const queue = new Queue(RETENTION_QUEUE_NAME, { connection })
    // Without a listener an error of the connection would be thrown as an uncaught exception
    queue.on('error', error => {
      this.logger.error(`Retention queue error: ${error.message}`)
    })
    this.queue = queue
    // One job at a time: both are database work that gains nothing from running side by side
    const worker = new Worker(RETENTION_QUEUE_NAME, job => this.process(job), {
      connection,
      concurrency: 1
    })
    worker.on('error', error => {
      this.logger.error(`Retention worker error: ${error.message}`)
    })
    this.worker = worker
    // Upserts: the same scheduler id on every start replaces the schedule instead of adding one
    await queue.upsertJobScheduler(
      PURGE_JOB_NAME,
      { pattern: PURGE_CRON },
      {
        name: PURGE_JOB_NAME,
        opts: {
          attempts: PURGE_ATTEMPTS,
          backoff: { type: 'exponential', delay: PURGE_BACKOFF_MS },
          removeOnComplete: FINISHED_RUNS_KEPT,
          removeOnFail: FAILED_RUNS_KEPT
        }
      }
    )
    await queue.upsertJobScheduler(
      SWEEP_JOB_NAME,
      { every: SWEEP_EVERY_MS },
      {
        name: SWEEP_JOB_NAME,
        opts: { removeOnComplete: FINISHED_RUNS_KEPT, removeOnFail: FAILED_RUNS_KEPT }
      }
    )
  }

  // Before Redis closes. close() waits for the run in hand; one stuck must not hold the shutdown.
  async onModuleDestroy(): Promise<void> {
    const { worker, queue } = this
    this.worker = undefined
    this.queue = undefined
    if (worker !== undefined) {
      await withTimeout(worker.close(), CLOSE_TIMEOUT_MS, 'retention worker close').catch(() =>
        worker.close(true)
      )
    }
    await queue?.close()
  }

  async process(job: Pick<Job, 'name'>): Promise<void> {
    if (job.name === PURGE_JOB_NAME) {
      const result = await this.purgeExpired()
      this.logger.log(
        `Purged ${result.deliveries} deliveries, ${result.messages} messages and ${result.idempotencyKeys} idempotency keys`
      )
      return
    }
    if (job.name === SWEEP_JOB_NAME) {
      await this.sweepPending()
      return
    }
    // Retrying a job nobody knows would only fail again
    throw new UnrecoverableError(`Unknown retention job ${job.name}`)
  }

  // Each purge runs even when another failed, so a table that cannot be purged does not keep the
  // others growing; the failure is reported at the end so BullMQ retries the run
  async purgeExpired(now: Date = new Date()): Promise<PurgeResult> {
    const failures: string[] = []
    const attempt = async (what: string, purge: () => Promise<number>): Promise<number> => {
      try {
        return await purge()
      } catch (error: unknown) {
        this.logger.error(`The purge of ${what} failed: ${errorKind(error)}`)
        failures.push(what)
        return 0
      }
    }
    const result: PurgeResult = {
      deliveries: await attempt('deliveries', () =>
        this.deliveries.deleteOlderThan(
          new Date(now.getTime() - this.config.DELIVERY_RETENTION_DAYS * MS_PER_DAY)
        )
      ),
      messages: await attempt('messages', () => this.messages.purgeExpired(now)),
      idempotencyKeys: await attempt('idempotency keys', () =>
        this.idempotency.deleteOlderThan(new Date(now.getTime() - IDEMPOTENCY_KEPT_MS))
      )
    }
    if (failures.length > 0) throw new Error(`The purge of ${failures.join(', ')} failed`)
    return result
  }

  // A `pending` delivery is one that a job will still try. Two things leave one behind with no job:
  // a crash between storing the row and queueing the job (the receiver never got the event), and a
  // receiver that answered 2xx while the row could not be written (it did). The sweep tells them
  // apart as far as the queue allows (a finished job is kept for an hour) but cannot be sure, so it
  // never marks a row delivered: it sends it to the dead letters with a reason, where `retry` can
  // send it again. A repeat is dropped by the receiver through `X-Gateway-Delivery`.
  //
  // A job that moves between states while the queue is read can be missed. Nothing is lost by it:
  // when the job runs it records its result over the failed row.
  async sweepPending(now: Date = new Date()): Promise<SweepResult> {
    const cutoff = new Date(now.getTime() - STALE_PENDING_MS)
    let states: Map<string, DeliveryJobState> | undefined
    let after: DeliveryCursor | undefined
    const result: SweepResult = { failed: 0, alive: 0 }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const stale = await this.deliveries.listStalePending(cutoff, PAGE_SIZE, after)
      if (stale.length === 0) break
      // The queue is read once per run, and only when there is something to ask it about
      states ??= await this.deliveryQueue.jobStates()
      for (const row of stale) {
        const state = states.get(row.id)
        if (state === 'live') {
          result.alive += 1
          continue
        }
        await this.deliveries.failUnqueued(row.id, reasonFor(state))
        result.failed += 1
      }
      after = stale.at(-1)
      if (stale.length < PAGE_SIZE) break
    }
    if (result.failed > 0) {
      this.metrics.metrics.webhookDeliveries.inc({ result: 'swept' }, result.failed)
      this.logger.warn(
        `${result.failed} pending deliveries had no job to run them and went to the dead letters`
      )
    }
    return result
  }
}
