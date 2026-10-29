import { Logger } from '@nestjs/common'

import { AppError, ConflictError, WhatsAppError } from '../common/errors.js'
import { abortableSleep } from '../common/lib/abortable-sleep.js'
import { resolveTypingMs, typingSegments } from '../common/lib/humanize.js'
import { IntervalThrottle } from '../common/lib/throttle.js'
import type { AppConfig } from '../config/env.schema.js'
import type { MessageDto } from '../types/dto.js'
import { WaDisconnectedError, WaTimeoutError } from '../whatsapp/wa-errors.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import type { SendPolicyService } from './send-policy.service.js'
import {
  failure,
  reviveContent,
  toErrorBody,
  type SendJobData,
  type SendJobResult
} from './send-queue.job.js'

type Config = Pick<
  AppConfig,
  | 'SEND_MIN_INTERVAL_MS'
  | 'SEND_JITTER_MS'
  | 'SEND_MAX_WAIT_MS'
  | 'SEND_NOT_READY_RETRY_MS'
  | 'HUMANIZE_MIN_REPLY_DELAY_MS'
>

export interface SendJobDependencies {
  config: Config
  // The client of the session when it is ready; throws SESSION_NOT_READY otherwise
  requireReady: (sessionId: string) => WhatsAppClientPort
  policy: Pick<SendPolicyService, 'admit'>
  random?: () => number
}

// What the processor needs from the job it runs, so it never touches BullMQ
export interface SendJobHooks {
  markDispatched: () => Promise<void>
  clearDispatched: () => Promise<void>
}

// The worker was asked to stop while the job waited: the job goes back to the queue with the time
// it has already waited, and the next run of the worker (this process after a restart) takes it up
export class SendJobYield extends Error {
  constructor(readonly waitedMs: number) {
    super('The send job yielded to a shutdown')
    this.name = 'SendJobYield'
  }
}

const bodyOf = (data: SendJobData): string | undefined => {
  if (data.content.type === 'text') return data.content.body
  return data.options?.caption
}

const isNotReady = (error: unknown): boolean =>
  error instanceof ConflictError && error.code === 'SESSION_NOT_READY'

// The browser or the page was in trouble: before the dispatch mark nothing was sent, whatever it says
const isSessionTrouble = (error: unknown): boolean =>
  error instanceof WaDisconnectedError || error instanceof WaTimeoutError

// A failure that proves nothing reached WhatsApp, so the send may be tried again
const isBeforeDispatch = (error: unknown): boolean =>
  (error instanceof WaDisconnectedError || error instanceof WaTimeoutError) && !error.dispatched

// Sends the jobs of ONE session, one at a time (the queue gives concurrency 1), so it can keep the
// pacing clock in a field. It waits for the session, asks the send policy, paces, humanizes and
// dispatches; it decides how the send ended and leaves the bookkeeping to the queue service.
export class SendJobProcessor {
  private readonly logger = new Logger(SendJobProcessor.name)
  private readonly throttle: IntervalThrottle

  constructor(
    private readonly sessionId: string,
    private readonly deps: SendJobDependencies
  ) {
    this.throttle = new IntervalThrottle({
      minIntervalMs: deps.config.SEND_MIN_INTERVAL_MS,
      jitterMs: deps.config.SEND_JITTER_MS,
      ...(deps.random === undefined ? {} : { random: deps.random })
    })
  }

  async run(data: SendJobData, hooks: SendJobHooks, signal: AbortSignal): Promise<SendJobResult> {
    // A previous run set the mark and never reported: the message may be out already
    if (data.dispatchedAt !== undefined) {
      return failure(
        {
          code: 'UNKNOWN_OUTCOME',
          message:
            'The gateway stopped while this message was being sent, so whether it was delivered is unknown. Check the chat before sending it again.',
          details: { dispatchedAt: new Date(data.dispatchedAt).toISOString() }
        },
        false
      )
    }

    const startedAt = Date.now()
    const waited = (): number => (data.waitedMs ?? 0) + (Date.now() - startedAt)
    // Every wait goes through here, so a shutdown always ends in a yield
    const pause = async (ms: number): Promise<void> => {
      if (!(await abortableSleep(ms, signal))) throw new SendJobYield(waited())
    }

    for (;;) {
      const client = await this.awaitReady(data, pause)
      if ('outcome' in client) return client
      const rejected = await this.awaitPolicy(data, waited, pause)
      if (rejected) return rejected
      await this.pace(pause)

      let marked = false
      try {
        await this.humanize(client, data, pause)
        await hooks.markDispatched()
        marked = true
        return await this.dispatch(client, data)
      } catch (error: unknown) {
        if (error instanceof SendJobYield) throw error
        // Not the send but the queue itself failed: nothing was dispatched
        if (!marked && !(error instanceof AppError)) throw error
        if (marked ? isBeforeDispatch(error) : isSessionTrouble(error)) {
          await hooks.clearDispatched()
          if (this.outOfTime(data)) return failure(toErrorBody(error))
          // No hammering of a client that keeps failing
          await pause(this.deps.config.SEND_NOT_READY_RETRY_MS)
          continue
        }
        return marked
          ? this.afterDispatch(error)
          : failure(toErrorBody(error), error instanceof WhatsAppError)
      }
    }
  }

  // Resolves with the client, or with the failure when the session did not come back in time
  private async awaitReady(
    data: SendJobData,
    pause: (ms: number) => Promise<void>
  ): Promise<WhatsAppClientPort | SendJobResult> {
    for (;;) {
      try {
        return this.deps.requireReady(this.sessionId)
      } catch (error: unknown) {
        if (!isNotReady(error)) return failure(toErrorBody(error))
        if (this.outOfTime(data)) return failure(toErrorBody(error))
        await pause(this.deps.config.SEND_NOT_READY_RETRY_MS)
      }
    }
  }

  // The time a job waits for a session that is not ready counts from the moment it was queued
  private outOfTime(data: SendJobData): boolean {
    return Date.now() - data.enqueuedAt >= this.deps.config.SEND_MAX_WAIT_MS
  }

  // A delay is waited out here and not by moving the job to the delayed set: a delayed job loses its
  // place, and the messages of a conversation must leave in the order they were accepted
  private async awaitPolicy(
    data: SendJobData,
    waited: () => number,
    pause: (ms: number) => Promise<void>
  ): Promise<SendJobResult | undefined> {
    for (;;) {
      const body = bodyOf(data)
      const decision = await this.deps.policy.admit({
        sessionId: this.sessionId,
        chatId: data.chatId,
        waitedMs: waited(),
        ...(body === undefined ? {} : { body })
      })
      if (decision.decision === 'allow') return undefined
      if (decision.decision === 'reject') {
        return failure({
          code: decision.code,
          message: `The send policy refused this message (${decision.rule})`,
          details: { rule: decision.rule }
        })
      }
      await pause(decision.delayMs)
    }
  }

  // SEND_MIN_INTERVAL_MS between two sends of the session, plus a random part up to SEND_JITTER_MS
  private async pace(pause: (ms: number) => Promise<void>): Promise<void> {
    const wait = this.throttle.reserve(this.sessionId)
    if (wait > 0) await pause(wait)
  }

  private async humanize(
    client: WhatsAppClientPort,
    data: SendJobData,
    pause: (ms: number) => Promise<void>
  ): Promise<void> {
    const humanize = data.humanize
    if (!humanize) return
    if (humanize.markSeenFirst) {
      // Marking as seen is a courtesy: the message goes out even when it fails
      await client.sendSeen(data.chatId).catch((error: unknown) => {
        this.logger.warn(`[${this.sessionId}] sendSeen failed (${toErrorBody(error).code})`)
      })
    }
    const typingMs = Math.max(
      resolveTypingMs(humanize.typing ?? 'auto', bodyOf(data)?.length ?? 0, this.deps.random),
      this.deps.config.HUMANIZE_MIN_REPLY_DELAY_MS
    )
    const state = humanize.recording === true ? 'recording' : 'typing'
    try {
      for (const segment of typingSegments(typingMs)) {
        await client.sendChatState(data.chatId, state)
        await pause(segment)
      }
    } finally {
      // Also when the send is given up: a typing indicator must never be left on
      await client.sendChatState(data.chatId, 'clear').catch(() => undefined)
    }
  }

  private async dispatch(client: WhatsAppClientPort, data: SendJobData): Promise<SendJobResult> {
    const message = await client.sendMessage(data.chatId, reviveContent(data.content), data.options)
    return { outcome: { ok: true, message }, hardFailure: isAckError(message) }
  }

  // Whatever went wrong once the call may have reached WhatsApp
  private afterDispatch(error: unknown): SendJobResult {
    const dispatched =
      error instanceof WaTimeoutError ||
      error instanceof WaDisconnectedError ||
      !(error instanceof AppError)
    if (dispatched) {
      return failure(
        {
          code: 'UNKNOWN_OUTCOME',
          message:
            'The send did not finish, so whether the message reached WhatsApp is unknown. It is not retried: check the chat before sending it again.',
          details: { cause: toErrorBody(error).code }
        },
        true
      )
    }
    return failure(toErrorBody(error), error instanceof WhatsAppError)
  }
}

const isAckError = (message: MessageDto): boolean => message.ack === -1
