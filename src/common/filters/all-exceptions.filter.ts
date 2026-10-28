import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import { REQUEST_ID_HEADER } from '../../infra/logger/logger.config.js'
import { AppError, ErrorCode } from '../errors.js'

// The body of every error response (TDD §6.11)
export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
    details?: Readonly<Record<string, unknown>>
    requestId: string
  }
}

interface DescribedError {
  status: number
  code: ErrorCode
  message: string
  details?: Readonly<Record<string, unknown>>
}

const INTERNAL_MESSAGE = 'Internal server error'
const FIRST_CLIENT_ERROR = 400
const FIRST_SERVER_ERROR = 500

// The statuses Nest and Fastify raise on their own (unknown route, malformed body, ...); any other
// 4xx keeps its status and is reported as a request the gateway could not accept
const CODE_BY_STATUS: Readonly<Partial<Record<number, ErrorCode>>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND
}

// Fastify's own errors (body too large, unsupported media type) carry a statusCode but are not HttpExceptions
function clientErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null || !('statusCode' in exception)) {
    return undefined
  }
  const { statusCode } = exception
  return typeof statusCode === 'number' &&
    statusCode >= FIRST_CLIENT_ERROR &&
    statusCode < FIRST_SERVER_ERROR
    ? statusCode
    : undefined
}

function errorMessage(exception: unknown): string {
  return exception instanceof Error ? exception.message : INTERNAL_MESSAGE
}

// Whatever was thrown, as the status and the error of the contract. An error that is the gateway's own
// fault (5xx that is not an AppError with a message of its own) never leaks its message in production.
export function describeException(exception: unknown, hideInternal: boolean): DescribedError {
  if (exception instanceof AppError) {
    const hidden = hideInternal && exception.code === ErrorCode.INTERNAL
    return {
      status: exception.status,
      code: exception.code,
      message: hidden ? INTERNAL_MESSAGE : exception.message,
      ...(exception.details !== undefined && !hidden && { details: exception.details })
    }
  }
  const status =
    exception instanceof HttpException ? exception.getStatus() : clientErrorStatus(exception)
  if (status !== undefined && status >= FIRST_CLIENT_ERROR && status < FIRST_SERVER_ERROR) {
    return {
      status,
      code: CODE_BY_STATUS[status] ?? ErrorCode.VALIDATION_ERROR,
      message: errorMessage(exception)
    }
  }
  return {
    status: status !== undefined && status >= FIRST_SERVER_ERROR ? status : FIRST_SERVER_ERROR,
    code: ErrorCode.INTERNAL,
    message: hideInternal ? INTERNAL_MESSAGE : errorMessage(exception)
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<FastifyRequest>()
    const reply = http.getResponse<FastifyReply>()
    const { status, ...error } = describeException(exception, this.config.NODE_ENV === 'production')
    if (status >= FIRST_SERVER_ERROR) this.logger.error(exception)
    const body: ErrorBody = { error: { ...error, requestId: request.id } }
    void reply.header(REQUEST_ID_HEADER, request.id).status(status).send(body)
  }
}
