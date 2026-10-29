import { AppError, type ErrorCode } from '../common/errors.js'
import type { MessageDto } from '../types/dto.js'
import type { OutboundContent, SendOptions } from '../whatsapp/whatsapp-client.port.js'

// What the worker does around the send, from the `humanize` field of the request
export interface HumanizeOptions {
  // 'auto' sizes the wait from the length of the text; a number is milliseconds
  typing?: 'auto' | number
  recording?: boolean
  markSeenFirst?: boolean
}

// The job as it lives in Redis. It carries everything the send needs, so a restart loses nothing.
export interface SendJobData {
  sessionId: string
  // Already resolved to a WhatsApp id: the phone lookup belongs to the caller
  chatId: string
  content: OutboundContent
  options?: SendOptions
  humanize?: HumanizeOptions
  idempotencyKey?: string
  // When the send was accepted, as a stamp that grows with every send (see SendQueueService.nextStamp)
  enqueuedAt: number
  // Milliseconds the job has already waited on the policy in earlier runs of the worker
  waitedMs?: number
  // Set right before the call to WhatsApp. A job that is picked up again with it set may have been
  // sent already, so it ends as UNKNOWN_OUTCOME instead of going out twice.
  dispatchedAt?: number
}

export type NewSendJob = Omit<SendJobData, 'enqueuedAt' | 'waitedMs' | 'dispatchedAt'>

export interface SendErrorBody {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

// How a job ended. A failed send is a finished job, not a failed BullMQ job: BullMQ would retry it.
export type SendJobOutcome = { ok: true; message: MessageDto } | { ok: false; error: SendErrorBody }

export type SendJobStatus =
  | { jobId: string; status: 'queued' | 'active' }
  | { jobId: string; status: 'sent'; message: MessageDto }
  | { jobId: string; status: 'failed'; error: SendErrorBody }

// What the processor reports besides the outcome, for the bookkeeping around it
export interface SendJobResult {
  outcome: SendJobOutcome
  // A WhatsApp failure or an ack -1: it feeds the health throttle and the circuit breaker
  hardFailure: boolean
}

// `Date` does not survive the trip through Redis: it comes back as an ISO string
export function reviveContent(content: OutboundContent): OutboundContent {
  if (content.type !== 'event') return content
  return {
    ...content,
    startTime: new Date(content.startTime),
    ...(content.endTime === undefined ? {} : { endTime: new Date(content.endTime) })
  }
}

export function toErrorBody(error: unknown): SendErrorBody {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: { ...error.details } })
    }
  }
  return { code: 'INTERNAL', message: 'Unexpected failure while sending' }
}

export const failure = (error: SendErrorBody, hardFailure = false): SendJobResult => ({
  outcome: { ok: false, error },
  hardFailure
})
