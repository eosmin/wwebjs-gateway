import { HttpStatus, Logger } from '@nestjs/common'
import type { FastifyReply } from 'fastify'

import { AppError, type ErrorCode, ValidationError } from '../../common/errors.js'
import type { SendResult } from '../../services/message-send.service.js'
import { MessageDto } from '../../types/dto.js'
import { IdempotencyKeyHeader, type SendJobDto } from '../../types/messages.dto.js'

// The errors every send route can answer
export const SEND_ERRORS: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'MEDIA_FETCH_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
  'NUMBER_NOT_ON_WHATSAPP',
  'POLICY_BLOCKED',
  'DUPLICATE_CONTENT',
  'RECIPIENT_SUPPRESSED',
  'RECIPIENT_UNREACHABLE',
  'POLICY_DELAY_EXCEEDED',
  'SESSION_NOT_READY',
  'UNKNOWN_OUTCOME',
  'ACK_ERROR',
  'WHATSAPP_ERROR',
  'WHATSAPP_TIMEOUT'
]

// The `Idempotency-Key` header of a send route, checked
export const idempotencyKeyOf = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined
  const parsed = IdempotencyKeyHeader.safeParse(header)
  if (!parsed.success) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      'The Idempotency-Key header must have 1 to 128 characters',
      { field: 'Idempotency-Key' }
    )
  }
  return parsed.data
}

const logger = new Logger('SendAnswer')

// The message of a send that went out is shown only when it fits its schema. A response that fails
// its schema becomes a 500, and a 500 after the message was sent makes the caller retry and send it
// twice, so a message that cannot be read is left out (and logged, by field, never by value) and the
// job still says `sent`. The message stays readable through the stored messages and the events.
export function readableMessage<T extends { jobId: string; message?: MessageDto | undefined }>(
  job: T
): T {
  if (job.message === undefined) return job
  const parsed = MessageDto.safeParse(job.message)
  if (parsed.success) return job
  const fields = parsed.error.issues.map(issue => issue.path.join('.')).join(', ')
  logger.error(`The message of send job ${job.jobId} does not fit its schema (${fields}); left out`)
  const rest: Partial<T> = { ...job }
  delete rest.message
  return rest as T
}

// The answer of every send route: 201 with the message when it went out, 202 with the job when it is
// still queued, and the error of the job when it failed
export function sendAnswer(result: SendResult, reply: FastifyReply): SendJobDto {
  if (result.replayed) void reply.header('idempotent-replayed', 'true')
  const { jobId, outcome } = result
  if (outcome === undefined) {
    void reply.status(HttpStatus.ACCEPTED)
    return { jobId, status: 'queued' }
  }
  if (!outcome.ok) {
    throw new AppError(outcome.error.code, outcome.error.message, outcome.error.details)
  }
  return readableMessage({
    jobId,
    status: 'sent',
    ...(outcome.message !== undefined && { message: outcome.message })
  })
}
