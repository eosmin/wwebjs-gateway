import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { DelayedError, Queue, Worker, type Job } from 'bullmq'

import { NotFoundError } from '../common/errors.js'
import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { IdempotencyRepository } from '../database/repositories/idempotency.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { RedisService } from '../infra/redis/redis.service.js'
import { EventPipelineService } from '../whatsapp/event-pipeline.service.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import { WatchdogService } from '../whatsapp/watchdog.service.js'

import { SendPolicyService } from './send-policy.service.js'
import {
  failure,
  toErrorBody,
  type NewSendJob,
  type SendJobData,
  type SendJobOutcome,
  type SendJobResult,
  type SendJobStatus,
  outcomeToJson
} from './send-queue.job.js'
import { SendJobProcessor, SendJobYield } from './send-queue.processor.js'

const JOB_NAME = 'send'
// BullMQ rejects ':' in a queue name, so the TDD's `send:<sessionId>` is written with a hyphen. A session id
// never holds ':' (it matches ^[-_\w]{1,64}$), so two sessions never share a queue.
export const sendQueueName = (sessionId: string): string => `send-${sessionId}`
const COMPLETED_KEPT_SECONDS = 3600
const FAILED_KEPT_SECONDS = 86_400
const CLOSE_TIMEOUT_MS = 15_000
// A job that makes way for an older one comes back after this long
const STEP_ASIDE_MS = 1000
// The ids of the waiting and delayed jobs the order check reads: more than any real backlog
const ORDER_CHECK_IDS = 10_000

type SendQueue = Queue<SendJobData, SendJobResult>

// Everything one session has: its queue, the worker that drains it and the state of its breaker
interface Lane {
  readonly sessionId: string
  readonly queue: SendQueue
  readonly worker: Worker<SendJobData, SendJobResult>
  readonly processor: SendJobProcessor
  readonly abort: AbortController
  consecutiveHardFailures: number
  breakerTimer: NodeJS.Timeout | undefined
  // True from the moment the call to WhatsApp starts until the job is accounted for
  dispatching: boolean
}

// A caller that waits for the result of one job
interface Waiter {
  sessionId: string
  // Answers the caller (undefined: the wait ends without a result) and stops its timer
  settle: (outcome?: SendJobOutcome) => void
}

export interface SubmitResult {
  jobId: string
  // Present when the caller waited and the job ended in time
  outcome?: SendJobOutcome
}

// The persistent send queue (TDD §6.8): one BullMQ queue and one worker (concurrency 1) per session.
// A message the API accepted is in Redis (AOF) before the call returns, so a restart loses nothing and
// a message is never sent twice: a job that was being dispatched when the process died ends as
// UNKNOWN_OUTCOME instead of going out again.
@Injectable()
export class SendQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendQueueService.name)
  private readonly lanes = new Map<string, Promise<Lane>>()
  // The same lanes once open, for the synchronous reads
  private readonly settledLanes = new Map<string, Lane>()
  // Callers that wait for the result of a job (sync sends). One instance, so no QueueEvents needed.
  private readonly waiters = new Map<string, Waiter>()
  private readonly queueWatchers = new Set<(queues: Queue[]) => void>()
  private unsubscribeRemoved: (() => void) | undefined
  private lastStamp = 0
  private closing = false

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(SessionsRepository) private readonly sessionRows: SessionsRepository,
    @Inject(SendPolicyService) private readonly policy: SendPolicyService,
    @Inject(EventPipelineService) private readonly pipeline: EventPipelineService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(WatchdogService) private readonly watchdog: WatchdogService,
    @Inject(IdempotencyRepository) private readonly idempotency: IdempotencyRepository
  ) {}

  // Opens a lane for every session so the jobs left by the last run drain as soon as it is ready
  async onModuleInit(): Promise<void> {
    this.unsubscribeRemoved = this.sessions.onRemoved(id => this.drop(id))
    this.watchdog.addBusyCheck(id => this.isSending(id))
    for (const session of await this.sessionRows.list()) await this.lane(session.id)
  }

  // Runs before the sessions are stopped and before Redis closes: the workers finish or yield their job
  async onModuleDestroy(): Promise<void> {
    this.closing = true
    this.unsubscribeRemoved?.()
    const lanes = await Promise.all([...this.lanes.values()].map(lane => lane.catch(() => null)))
    await Promise.all(lanes.flatMap(lane => (lane ? [this.closeLane(lane)] : [])))
    this.lanes.clear()
  }

  // ---- API -------------------------------------------------------------------------------------

  // Queues a send. With `waitMs` it also waits that long for the result, and the caller then owns
  // announcing it; without, or when the wait runs out, the result is published as an event. A `jobId`
  // chosen by the caller makes the add idempotent: BullMQ ignores a second job with the same id.
  async submit(
    job: NewSendJob,
    options: { waitMs?: number; jobId?: string } = {}
  ): Promise<SubmitResult> {
    // 404 for a session that does not exist, before any queue is made for it
    this.sessions.status(job.sessionId)
    // Taken before any await, so the order of the stamps is the order in which sends were accepted
    const stamp = this.nextStamp()
    const lane = await this.lane(job.sessionId)
    const jobId = options.jobId ?? randomUUID()
    const waiting =
      options.waitMs === undefined ? undefined : this.waitFor(job.sessionId, jobId, options.waitMs)
    try {
      await lane.queue.add(
        JOB_NAME,
        { ...job, enqueuedAt: stamp },
        {
          jobId,
          // BullMQ keeps it in the hash of the job, where the order check reads it without loading the data
          timestamp: stamp,
          attempts: 1,
          removeOnComplete: { age: COMPLETED_KEPT_SECONDS },
          removeOnFail: { age: FAILED_KEPT_SECONDS }
        }
      )
    } catch (error: unknown) {
      // The caller gets the error, not a wait; the timer must not outlive the call
      this.waiters.get(jobId)?.settle()
      throw error
    }
    await this.refreshDepth(lane)
    const outcome = await waiting
    return outcome === undefined ? { jobId } : { jobId, outcome }
  }

  async status(sessionId: string, jobId: string): Promise<SendJobStatus> {
    this.sessions.status(sessionId)
    const lane = await this.lane(sessionId)
    // The state first: a job read before it completes would come back without its result
    const state = await lane.queue.getJobState(jobId)
    if (state === 'unknown')
      throw new NotFoundError('NOT_FOUND', `Send job ${jobId} does not exist`)
    if (state === 'completed') {
      const outcome = (await lane.queue.getJob(jobId))?.returnvalue?.outcome
      if (!outcome) throw new NotFoundError('NOT_FOUND', `Send job ${jobId} does not exist`)
      return outcome.ok
        ? { jobId, status: 'sent', message: outcome.message }
        : { jobId, status: 'failed', error: outcome.error }
    }
    if (state === 'failed') {
      // The same answer the caller got: a job that failed after the mark may have been sent
      const dispatched = (await lane.queue.getJob(jobId))?.data.dispatchedAt !== undefined
      return {
        jobId,
        status: 'failed',
        error: dispatched
          ? {
              code: 'UNKNOWN_OUTCOME',
              message: 'The gateway failed while the message was being sent'
            }
          : { code: 'INTERNAL', message: 'The gateway failed before the message was sent' }
      }
    }
    return { jobId, status: state === 'active' ? 'active' : 'queued' }
  }

  // The clock in milliseconds, forced to grow by at least 1 per call: two sends accepted in the same
  // millisecond, or after the clock stepped back, still have an order. One instance by design, so one
  // counter is enough.
  private nextStamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return this.lastStamp
  }

  // For the dashboard: the queues now and again whenever a session gets or loses one
  watchQueues(listener: (queues: Queue[]) => void): () => void {
    this.queueWatchers.add(listener)
    listener(this.queues())
    return () => this.queueWatchers.delete(listener)
  }

  private queues(): Queue[] {
    return [...this.settledLanes.values()].map(lane => lane.queue)
  }

  private notifyQueuesChanged(): void {
    for (const listener of this.queueWatchers) listener(this.queues())
  }

  // True while a call to WhatsApp is in flight for the session: the memory guard never restarts it
  isSending(sessionId: string): boolean {
    return this.settledLanes.get(sessionId)?.dispatching ?? false
  }

  // ---- Lanes -----------------------------------------------------------------------------------

  private lane(sessionId: string): Promise<Lane> {
    if (this.closing) return Promise.reject(new Error('The send queue is shutting down'))
    let lane = this.lanes.get(sessionId)
    if (!lane) {
      lane = this.openLane(sessionId)
      this.lanes.set(sessionId, lane)
      lane.catch(() => this.lanes.delete(sessionId))
    }
    return lane
  }

  private async openLane(sessionId: string): Promise<Lane> {
    const queue: SendQueue = new Queue(sendQueueName(sessionId), { connection: this.redis.client })
    // A breaker that was open when the process stopped is not remembered, so the queue starts running
    await queue.resume()
    const abort = new AbortController()
    const processor = new SendJobProcessor(sessionId, {
      config: this.config,
      requireReady: id => this.sessions.requireReady(id),
      policy: this.policy
    })
    // `lane` is assigned below, before the worker can pick a job: it is created with `autorun: false`
    // eslint-disable-next-line prefer-const -- referenced by the processor callback below
    let lane!: Lane
    const worker = new Worker<SendJobData, SendJobResult>(
      sendQueueName(sessionId),
      (job, token) => this.process(lane, job, token),
      { connection: this.redis.client, concurrency: 1, autorun: false }
    )
    worker.on('completed', (job, result) => {
      void this.settle(lane, job, result)
    })
    // Backstop for what escapes `process` (the queue itself failing): the caller still gets an answer
    worker.on('failed', job => {
      if (!job) return
      void this.settle(lane, job, this.unexpected(lane, job, new Error('send job failed')))
    })
    worker.on('error', error => {
      this.logger.error(`[${sessionId}] Send worker error: ${error.message}`)
    })
    lane = {
      sessionId,
      queue,
      worker,
      processor,
      abort,
      consecutiveHardFailures: 0,
      breakerTimer: undefined,
      dispatching: false
    }
    this.settledLanes.set(sessionId, lane)
    this.notifyQueuesChanged()
    void worker.run().catch((error: unknown) => {
      this.logger.error(`[${sessionId}] Send worker stopped: ${toErrorBody(error).message}`)
    })
    await this.refreshDepth(lane)
    return lane
  }

  private async closeLane(lane: Lane): Promise<void> {
    lane.abort.abort()
    if (lane.breakerTimer) clearTimeout(lane.breakerTimer)
    // close() waits for the job in hand; a job stuck in WhatsApp must not hold the shutdown forever
    await withTimeout(lane.worker.close(), CLOSE_TIMEOUT_MS, 'send worker close').catch(() =>
      lane.worker.close(true)
    )
    await lane.queue.close()
    this.settledLanes.delete(lane.sessionId)
    this.notifyQueuesChanged()
  }

  // The session was deleted: its worker stops and whatever it still held is discarded
  private async drop(sessionId: string): Promise<void> {
    // Nobody will ever finish these jobs: answer the callers now instead of at their timeout
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.sessionId === sessionId) {
        waiter.settle({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Session ${sessionId} was deleted` }
        })
      }
    }
    const pending = this.lanes.get(sessionId)
    this.lanes.delete(sessionId)
    if (!pending) return
    // A lane that never opened has nothing to close, but its queue may hold jobs
    const lane = await pending.catch(() => undefined)
    if (lane) await this.closeLane(lane)
    const queue = new Queue(sendQueueName(sessionId), { connection: this.redis.client })
    try {
      await queue.obliterate({ force: true })
    } finally {
      await queue.close()
    }
    this.metrics.metrics.sendQueueDepth.remove({ session: sessionId })
  }

  // ---- Processing ------------------------------------------------------------------------------

  private async process(
    lane: Lane,
    job: Job<SendJobData, SendJobResult>,
    token: string | undefined
  ): Promise<SendJobResult> {
    const startedAt = Date.now()
    let result: SendJobResult
    try {
      if (await this.hasOlderPending(lane, job)) await this.makeWay(lane, job, token)
      result = await lane.processor.run(
        job.data,
        {
          markDispatched: async () => {
            // Set first: from the moment the mark may be in Redis the memory guard must see a send
            lane.dispatching = true
            try {
              await job.updateData({ ...job.data, dispatchedAt: Date.now() })
            } catch (error: unknown) {
              // The call to WhatsApp never started, so this is not an unknown outcome
              lane.dispatching = false
              throw error
            }
          },
          clearDispatched: async () => {
            lane.dispatching = false
            const rest = { ...job.data }
            delete rest.dispatchedAt
            await job.updateData(rest)
          }
        },
        lane.abort.signal
      )
    } catch (error: unknown) {
      if (error instanceof DelayedError) throw error
      if (error instanceof SendJobYield) {
        await this.putAside(job, token, this.config.SEND_NOT_READY_RETRY_MS, error.waitedMs)
      }
      result = this.unexpected(lane, job, error)
    } finally {
      lane.dispatching = false
    }
    await this.finish(lane, job, result, startedAt)
    return result
  }

  // A job that is still waiting for the session when the worker stops, or that has to make way for an
  // older one, goes to the delayed set with the time it already waited. It never falls back to the
  // BullMQ default of failing the job: a message that never started must not be lost.
  private async putAside(
    job: Job<SendJobData, SendJobResult>,
    token: string | undefined,
    delayMs: number,
    waitedMs?: number
  ): Promise<never> {
    if (waitedMs !== undefined) await job.updateData({ ...job.data, waitedMs })
    await job.moveToDelayed(Date.now() + delayMs, token)
    throw new DelayedError()
  }

  // Goes to the delayed set for a moment so the older job runs first. If that cannot be done the job
  // runs now, out of order: a late message is better than one that was never sent.
  private async makeWay(
    lane: Lane,
    job: Job<SendJobData, SendJobResult>,
    token: string | undefined
  ): Promise<void> {
    try {
      await this.putAside(job, token, STEP_ASIDE_MS)
    } catch (error: unknown) {
      if (error instanceof DelayedError) throw error
      this.logger.warn(
        `[${lane.sessionId}] Could not make way for an older job (${toErrorBody(error).code})`
      )
    }
  }

  // After a restart the job that was put aside is promoted to the END of the waiting list once it is
  // due, behind the ones that never left it. Those take the first turn only to find it and make way,
  // so the chat keeps its order. It reads the ids of the waiting and delayed jobs and one field of
  // each (the stamp), never the data: a backlog of media would otherwise be loaded on every turn.
  // An error here must not fail a send that nothing is wrong with.
  private async hasOlderPending(
    lane: Lane,
    job: Job<SendJobData, SendJobResult>
  ): Promise<boolean> {
    try {
      const client = this.redis.client
      const [waiting, delayed] = await Promise.all([
        client.lrange(lane.queue.toKey('wait'), 0, ORDER_CHECK_IDS - 1),
        client.zrange(lane.queue.toKey('delayed'), '0', String(ORDER_CHECK_IDS - 1))
      ])
      const others = [...waiting, ...delayed].filter(id => id !== job.id)
      if (others.length === 0) return false
      const reads = client.pipeline()
      for (const id of others) reads.hget(lane.queue.toKey(id), 'timestamp')
      const answers = (await reads.exec()) ?? []
      return answers.some(([error, stamp]) => error === null && Number(stamp) < job.timestamp)
    } catch (error: unknown) {
      this.logger.warn(`[${lane.sessionId}] Order check failed (${toErrorBody(error).code})`)
      return false
    }
  }

  // The processor threw: the gateway failed, not WhatsApp. If the call may have gone out, say so.
  private unexpected(
    lane: Lane,
    job: Job<SendJobData, SendJobResult>,
    error: unknown
  ): SendJobResult {
    this.logger.error(
      `[${lane.sessionId}] Send job ${job.id ?? '?'} threw ${error instanceof Error ? error.name : typeof error}`
    )
    if (lane.dispatching || job.data.dispatchedAt !== undefined) {
      return failure({
        code: 'UNKNOWN_OUTCOME',
        message:
          'The gateway failed while the message was being sent, so whether it was delivered is unknown. Check the chat before sending it again.'
      })
    }
    return failure({ code: 'INTERNAL', message: 'The gateway failed before the message was sent' })
  }

  // The accounting of a finished job. Nothing here may lose the outcome, which is already in the job.
  private async finish(
    lane: Lane,
    job: Job<SendJobData, SendJobResult>,
    result: SendJobResult,
    startedAt: number
  ): Promise<void> {
    const { outcome } = result
    await this.guarded(lane, 'metrics', () => {
      const { sends, sendDurationSeconds } = this.metrics.metrics
      sends.inc({ result: outcome.ok ? 'sent' : outcome.error.code })
      sendDurationSeconds.observe((Date.now() - startedAt) / 1000)
      return Promise.resolve()
    })

    await this.guarded(lane, 'health', async () => {
      const degraded = await this.policy.recordOutcome(
        lane.sessionId,
        result.hardFailure ? 'hard_failure' : 'ok'
      )
      if (degraded) {
        await this.pipeline.publish(lane.sessionId, 'session_error', {
          code: 'SEND_HEALTH_DEGRADED',
          message: 'Too many sends failed: the send budgets of the session are halved for a while'
        })
      }
    })
    await this.guarded(lane, 'breaker', () => this.trackBreaker(lane, result.hardFailure))
  }

  // After BullMQ has recorded the job as completed, so a caller that was just answered finds the
  // result when it asks for the job. A crash between the two loses the announcement, not the result.
  private async settle(
    lane: Lane,
    job: Job<SendJobData, SendJobResult>,
    result: SendJobResult
  ): Promise<void> {
    const jobId = job.id ?? ''
    await this.guarded(lane, 'idempotency', () => this.recordIdempotency(job.data, result.outcome))
    const waiter = this.waiters.get(jobId)
    if (waiter) {
      waiter.settle(result.outcome)
    } else {
      await this.guarded(lane, 'event', () => this.announce(lane, jobId, job.data, result.outcome))
    }
    await this.refreshDepth(lane)
  }

  // The key ends with the job, so a replay after BullMQ has dropped the job still gets the answer
  private async recordIdempotency(data: SendJobData, outcome: SendJobOutcome): Promise<void> {
    if (data.idempotencyKey === undefined) return
    if (outcome.ok) {
      await this.idempotency.complete(data.sessionId, data.idempotencyKey, {
        messageId: outcome.message.id,
        response: outcomeToJson(outcome)
      })
    } else {
      await this.idempotency.fail(data.sessionId, data.idempotencyKey, {
        response: outcomeToJson(outcome)
      })
    }
  }

  private async announce(
    lane: Lane,
    jobId: string,
    data: SendJobData,
    outcome: SendJobOutcome
  ): Promise<void> {
    const key = data.idempotencyKey === undefined ? {} : { idempotencyKey: data.idempotencyKey }
    if (outcome.ok) {
      await this.pipeline.publish(lane.sessionId, 'message_sent', {
        jobId,
        ...key,
        message: outcome.message
      })
    } else {
      await this.pipeline.publish(lane.sessionId, 'message_failed', {
        jobId,
        ...key,
        error: outcome.error
      })
    }
  }

  // SEND_BREAKER_THRESHOLD hard failures in a row pause the queue of the session for the cooldown
  private async trackBreaker(lane: Lane, hardFailure: boolean): Promise<void> {
    if (!hardFailure) {
      lane.consecutiveHardFailures = 0
      return
    }
    lane.consecutiveHardFailures += 1
    if (lane.consecutiveHardFailures < this.config.SEND_BREAKER_THRESHOLD) return
    lane.consecutiveHardFailures = 0
    await lane.queue.pause()
    // The lane was closed while the queue was being paused: it must not leave a timer behind
    if (lane.abort.signal.aborted) return
    lane.breakerTimer = setTimeout(() => {
      lane.breakerTimer = undefined
      lane.queue.resume().catch((error: unknown) => {
        this.logger.error(
          `[${lane.sessionId}] Could not resume the queue: ${toErrorBody(error).message}`
        )
      })
    }, this.config.SEND_BREAKER_COOLDOWN_MS)
    lane.breakerTimer.unref()
    await this.pipeline.publish(lane.sessionId, 'session_error', {
      code: 'SEND_BREAKER_OPEN',
      message: `Sending is paused for ${this.config.SEND_BREAKER_COOLDOWN_MS} ms after repeated failures`
    })
  }

  private async guarded(lane: Lane, step: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error: unknown) {
      this.logger.error(
        `[${lane.sessionId}] Send bookkeeping failed at ${step}: ${toErrorBody(error).message}`
      )
    }
  }

  private async refreshDepth(lane: Lane): Promise<void> {
    try {
      const counts = await lane.queue.getJobCounts('waiting', 'delayed')
      const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0)
      this.metrics.metrics.sendQueueDepth.set({ session: lane.sessionId }, depth)
    } catch {
      // A gauge is not worth failing a send for
    }
  }

  private waitFor(
    sessionId: string,
    jobId: string,
    waitMs: number
  ): Promise<SendJobOutcome | undefined> {
    return new Promise(resolve => {
      const timer = setTimeout(() => this.waiters.get(jobId)?.settle(), waitMs)
      this.waiters.set(jobId, {
        sessionId,
        settle: outcome => {
          clearTimeout(timer)
          this.waiters.delete(jobId)
          resolve(outcome)
        }
      })
    })
  }
}
