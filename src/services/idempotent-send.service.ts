import { Inject, Injectable } from '@nestjs/common'

import { ErrorCode, NotFoundError, UnprocessableError } from '../common/errors.js'
import { canonicalJson } from '../common/lib/canonical-json.js'
import { sha256Hex } from '../common/lib/crypto.js'
import type { IdempotencyKey } from '../database/models.js'
import { IdempotencyRepository } from '../database/repositories/idempotency.repository.js'

import { outcomeToJson, type NewSendJob, type SendJobOutcome } from './send-queue.job.js'
import { SendQueueService } from './send-queue.service.js'

// A key that is still `pending` this long after the claim, with no job in the queue, belongs to a
// process that died between the claim and the end of the job
export const STALE_PENDING_MS = 300_000

export interface IdempotentSendResult {
  jobId: string
  // Present when the send ended and the caller could be told: the wait, or the stored result of a replay
  outcome?: SendJobOutcome
  // True when the key had been used before with the same request, so nothing was queued
  replayed: boolean
}

const STALE_OUTCOME: SendJobOutcome = {
  ok: false,
  error: {
    code: 'UNKNOWN_OUTCOME',
    message:
      'The gateway stopped while this send was in progress, so whether it was delivered is unknown. Check the chat before sending it again with a new key.'
  }
}

// The job id follows from the key, so the queue itself refuses a second job for it
const jobIdFor = (sessionId: string, key: string): string =>
  `idem-${sha256Hex(`${sessionId}\0${key}`).slice(0, 32)}`

// What makes two requests "the same": everything the send depends on, except the key and the session
// (the key is scoped to the session already)
const requestHash = (job: NewSendJob): string =>
  sha256Hex(
    canonicalJson({
      chatId: job.chatId,
      content: job.content,
      options: job.options,
      humanize: job.humanize
    })
  )

// A stored answer is trusted only when it has the shape of one: a failure whose code no longer
// exists would otherwise turn a replay into a 500
const isOutcome = (value: unknown): value is SendJobOutcome => {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  if (value.ok === true) return true
  if (value.ok !== false || !('error' in value)) return false
  const { error } = value
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code in ErrorCode &&
    'message' in error &&
    typeof error.message === 'string'
  )
}

// Idempotent sends: the same key with the same request gives back the original result and never
// queues a second send; the same key with another request is refused.
@Injectable()
export class IdempotentSendService {
  constructor(
    @Inject(IdempotencyRepository) private readonly keys: IdempotencyRepository,
    @Inject(SendQueueService) private readonly queue: SendQueueService
  ) {}

  // The stored answer of a key that was used before, or undefined when it was not. It queues and
  // claims nothing, so a caller can look before it does work a replay does not need (resolving the
  // recipient, downloading media) and before the send policy, which may say no by now to a request
  // that already succeeded.
  async peek(
    sessionId: string,
    key: string,
    hash: string
  ): Promise<IdempotentSendResult | undefined> {
    const existing = await this.keys.find(sessionId, key)
    return existing ? this.replay(sessionId, existing, hash) : undefined
  }

  // `requestHash` is what makes two requests the same; a caller that has the raw request passes the
  // hash of that, because the job holds resolved values (downloaded bytes, session defaults) that can
  // differ between two identical requests
  async send(
    job: NewSendJob,
    { requestHash: given, ...options }: { waitMs?: number; requestHash?: string } = {}
  ): Promise<IdempotentSendResult> {
    const key = job.idempotencyKey
    if (key === undefined) return { ...(await this.queue.submit(job, options)), replayed: false }

    const hash = given ?? requestHash(job)
    const claim = await this.keys.claim(job.sessionId, key, hash)
    if (!claim.claimed) return this.replay(job.sessionId, claim.existing, hash)

    try {
      const jobId = jobIdFor(job.sessionId, key)
      return { ...(await this.queue.submit(job, { ...options, jobId })), replayed: false }
    } catch (error: unknown) {
      // Only a refusal that comes before the add (the session does not exist) proves nothing was
      // queued. Any other error may have left the job in Redis, so the key stays `pending` and heals
      // through the job lookup: a retry never sends twice and never gets a fresh claim.
      // A failed release leaves the key pending, which heals; the error to report is the first one
      if (error instanceof NotFoundError)
        await this.keys.release(job.sessionId, key).catch(() => false)
      throw error
    }
  }

  private async replay(
    sessionId: string,
    existing: IdempotencyKey,
    hash: string
  ): Promise<IdempotentSendResult> {
    if (existing.requestHash !== hash) {
      throw new UnprocessableError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request'
      )
    }
    const jobId = jobIdFor(sessionId, existing.key)
    if (existing.status !== 'pending') {
      return { jobId, replayed: true, ...this.stored(existing) }
    }
    return this.replayPending(sessionId, existing, jobId)
  }

  // A key that ended answers with what was stored when it ended
  private stored(existing: IdempotencyKey): { outcome?: SendJobOutcome } {
    return isOutcome(existing.response) ? { outcome: existing.response } : {}
  }

  private async replayPending(
    sessionId: string,
    existing: IdempotencyKey,
    jobId: string
  ): Promise<IdempotentSendResult> {
    try {
      const status = await this.queue.status(sessionId, jobId)
      if (status.status !== 'sent' && status.status !== 'failed') return { jobId, replayed: true }
      // The job ended but the key did not hear about it (the process died in between)
      const outcome: SendJobOutcome =
        status.status === 'sent'
          ? { ok: true, ...(status.message !== undefined && { message: status.message }) }
          : { ok: false, error: status.error }
      await this.end(sessionId, existing.key, outcome)
      return { jobId, outcome, replayed: true }
    } catch (error: unknown) {
      if (!(error instanceof NotFoundError)) throw error
    }
    // No job: it is being queued right now, or it is lost. Never queue it again either way.
    if (Date.now() - existing.createdAt.getTime() < STALE_PENDING_MS) {
      return { jobId, replayed: true }
    }
    await this.end(sessionId, existing.key, STALE_OUTCOME)
    return { jobId, outcome: STALE_OUTCOME, replayed: true }
  }

  private async end(sessionId: string, key: string, outcome: SendJobOutcome): Promise<void> {
    if (outcome.ok) {
      await this.keys.complete(sessionId, key, {
        messageId: outcome.message?.id ?? null,
        response: outcomeToJson(outcome)
      })
    } else {
      await this.keys.fail(sessionId, key, { response: outcomeToJson(outcome) })
    }
  }
}
