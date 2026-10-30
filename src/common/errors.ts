import { HttpStatus } from '@nestjs/common'

// Every code the API can answer with. The value is the code itself, so a string literal such as
// 'SESSION_NOT_READY' is accepted wherever an ErrorCode is expected.
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  API_KEY_EXPIRED: 'API_KEY_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
  SESSION_ALREADY_EXISTS: 'SESSION_ALREADY_EXISTS',
  MAX_SESSIONS_REACHED: 'MAX_SESSIONS_REACHED',
  SESSION_NOT_READY: 'SESSION_NOT_READY',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  MEDIA_FETCH_FAILED: 'MEDIA_FETCH_FAILED',
  NUMBER_NOT_ON_WHATSAPP: 'NUMBER_NOT_ON_WHATSAPP',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  DUPLICATE_CONTENT: 'DUPLICATE_CONTENT',
  RECIPIENT_SUPPRESSED: 'RECIPIENT_SUPPRESSED',
  RECIPIENT_UNREACHABLE: 'RECIPIENT_UNREACHABLE',
  POLICY_DELAY_EXCEEDED: 'POLICY_DELAY_EXCEEDED',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  ACK_ERROR: 'ACK_ERROR',
  WHATSAPP_ERROR: 'WHATSAPP_ERROR',
  WHATSAPP_TIMEOUT: 'WHATSAPP_TIMEOUT',
  INTERNAL: 'INTERNAL'
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

interface ErrorDefinition {
  status: HttpStatus
  meaning: string
}

// The single source of the HTTP status and the meaning of each code; docs/errors.md is generated from it
export const ERROR_DEFINITIONS = {
  VALIDATION_ERROR: {
    status: HttpStatus.BAD_REQUEST,
    meaning: 'The request does not match the schema of the operation; details holds the issues.'
  },
  UNAUTHORIZED: {
    status: HttpStatus.UNAUTHORIZED,
    meaning: 'The API key is missing or invalid.'
  },
  API_KEY_EXPIRED: {
    status: HttpStatus.UNAUTHORIZED,
    meaning: 'The API key was valid but its expiry date has passed.'
  },
  FORBIDDEN: {
    status: HttpStatus.FORBIDDEN,
    meaning: 'The API key is not allowed to use this session.'
  },
  INSUFFICIENT_SCOPE: {
    status: HttpStatus.FORBIDDEN,
    meaning: 'The API key lacks the permission scope the operation requires.'
  },
  IP_NOT_ALLOWED: {
    status: HttpStatus.FORBIDDEN,
    meaning: 'The request comes from an address outside the allowed CIDRs of the API key.'
  },
  NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    meaning: 'The route or the resource does not exist.'
  },
  CHAT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    meaning: 'The session has no chat with that id.'
  },
  SESSION_ALREADY_EXISTS: {
    status: HttpStatus.CONFLICT,
    meaning: 'A session with that id already exists.'
  },
  MAX_SESSIONS_REACHED: {
    status: HttpStatus.CONFLICT,
    meaning: 'The number of running sessions has reached MAX_SESSIONS.'
  },
  SESSION_NOT_READY: {
    status: HttpStatus.CONFLICT,
    meaning:
      'The session is not connected to WhatsApp yet; retry when it is ready. A queued send that waits longer than SEND_MAX_WAIT_MS ends with this code.'
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    meaning: 'The Idempotency-Key was already used with a different request.'
  },
  RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    meaning:
      'The API key or the client address sent more than RATE_LIMIT_MAX requests in a minute; wait the seconds in the Retry-After header.'
  },
  PAYLOAD_TOO_LARGE: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    meaning:
      'The request body is larger than the route accepts: 1 MiB in general, 40 MiB on the routes that send media.'
  },
  MEDIA_FETCH_FAILED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    meaning:
      'The media of a send could not be downloaded from its URL: the server failed, redirected, was too slow, or the file is larger than MAX_MEDIA_BYTES.'
  },
  NUMBER_NOT_ON_WHATSAPP: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    meaning: 'The phone number is not registered on WhatsApp.'
  },
  POLICY_BLOCKED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    meaning:
      'The send policy rejected the message by a rule that has no code of its own; details.rule names the rule.'
  },
  DUPLICATE_CONTENT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    meaning:
      'The same text was already sent to too many different chats in a short time (rule of the send policy).'
  },
  RECIPIENT_SUPPRESSED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    meaning: 'The chat is on the suppression list of the session (rule of the send policy).'
  },
  RECIPIENT_UNREACHABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    meaning:
      'The chat is flagged unreachable, so cold sends to it are rejected (rule of the send policy).'
  },
  POLICY_DELAY_EXCEEDED: {
    status: HttpStatus.GATEWAY_TIMEOUT,
    meaning:
      'The send policy kept the message waiting longer than SEND_POLICY_MAX_WAIT_MS, so it was given up.'
  },
  UNKNOWN_OUTCOME: {
    status: HttpStatus.BAD_GATEWAY,
    meaning:
      'The send timed out after it was dispatched, so whether it reached WhatsApp is unknown; it is never retried automatically.'
  },
  ACK_ERROR: {
    status: HttpStatus.BAD_GATEWAY,
    meaning: 'WhatsApp reported a delivery error (ack -1) for the message.'
  },
  WHATSAPP_ERROR: {
    status: HttpStatus.BAD_GATEWAY,
    meaning:
      'WhatsApp Web failed to carry out the operation. `details.kind: "mapping"` marks the case where the operation ran but the gateway could not read its answer.'
  },
  WHATSAPP_TIMEOUT: {
    status: HttpStatus.GATEWAY_TIMEOUT,
    meaning: 'WhatsApp Web did not answer within WA_CALL_TIMEOUT_MS.'
  },
  INTERNAL: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    meaning: 'Unexpected failure of the gateway; the message is hidden in production.'
  }
} as const satisfies Record<ErrorCode, ErrorDefinition>

type CodesWithStatus<S extends HttpStatus> = {
  [C in ErrorCode]: (typeof ERROR_DEFINITIONS)[C]['status'] extends S ? C : never
}[ErrorCode]

export class AppError extends Error {
  readonly status: HttpStatus
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    readonly code: ErrorCode,
    message?: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message ?? ERROR_DEFINITIONS[code].meaning)
    this.name = new.target.name
    this.status = ERROR_DEFINITIONS[code].status
    this.details = details
  }
}

// The subclasses only narrow which codes a status accepts: the status itself comes from the code
class StatusError<C extends ErrorCode> extends AppError {
  constructor(code: C, message?: string, details?: Readonly<Record<string, unknown>>) {
    super(code, message, details)
  }
}

export class ValidationError extends StatusError<CodesWithStatus<HttpStatus.BAD_REQUEST>> {}
export class UnauthorizedError extends StatusError<CodesWithStatus<HttpStatus.UNAUTHORIZED>> {}
export class ForbiddenError extends StatusError<CodesWithStatus<HttpStatus.FORBIDDEN>> {}
export class NotFoundError extends StatusError<CodesWithStatus<HttpStatus.NOT_FOUND>> {}
export class ConflictError extends StatusError<CodesWithStatus<HttpStatus.CONFLICT>> {}
export class PayloadTooLargeError extends StatusError<
  CodesWithStatus<HttpStatus.PAYLOAD_TOO_LARGE>
> {}
export class UnprocessableError extends StatusError<
  CodesWithStatus<HttpStatus.UNPROCESSABLE_ENTITY>
> {}
export class WhatsAppError extends StatusError<
  CodesWithStatus<HttpStatus.BAD_GATEWAY | HttpStatus.GATEWAY_TIMEOUT>
> {}
export class InternalError extends StatusError<CodesWithStatus<HttpStatus.INTERNAL_SERVER_ERROR>> {}
