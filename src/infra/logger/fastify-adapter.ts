import type { IncomingMessage } from 'node:http'

import { FastifyAdapter } from '@nestjs/platform-fastify'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

import { REQUEST_ID_HEADER, resolveRequestId } from './logger.config.js'

// Every route takes a body of this size at most; the sends that carry media are raised on their own routes
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024

// The routes that take media as base64 (TDD §6.11 cross-cutting): 32 MiB of file is about 43 MiB of
// base64, and MAX_MEDIA_BYTES is checked on the decoded size, so this is only the ceiling of the body
export const SEND_BODY_LIMIT_BYTES = 40 * 1024 * 1024
export const SEND_ROUTES: ReadonlySet<string> = new Set([
  '/v1/sessions/:sessionId/messages',
  '/v1/sessions/:sessionId/messages/:messageId/reply',
  '/v1/sessions/:sessionId/channels/:channelId/messages'
])

const URI_TOO_LONG = 414
const BAD_REQUEST = 400
const SERVER_ERROR = 500

// What a URL that the router itself refuses says. The router answers before any guard or filter of Nest
// runs, in its own shape and with the URL in the message, and the URL of an inbound hook holds its token,
// so the answer is the error contract with a fixed message that never repeats the URL.
export function answerFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const tooLong = error.statusCode === URI_TOO_LONG
  const serverFault = (error.statusCode ?? BAD_REQUEST) >= SERVER_ERROR
  const status = tooLong ? URI_TOO_LONG : serverFault ? SERVER_ERROR : BAD_REQUEST
  const code = serverFault ? 'INTERNAL' : 'VALIDATION_ERROR'
  const message = serverFault
    ? 'Internal server error'
    : tooLong
      ? 'The request URL is too long'
      : 'The request URL is not valid'
  void reply
    .header(REQUEST_ID_HEADER, request.id)
    .status(status)
    .send({ error: { code, message, requestId: request.id } })
}

// Fastify numbers requests (`req-1`) and pino-http keeps an id that is already set, so the id a caller
// sends in x-request-id has to be chosen here for the logs to carry it
export function createFastifyAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id']),
    frameworkErrors: answerFrameworkError
  })
  adapter.getInstance().addHook('onRoute', route => {
    if (route.method === 'POST' && SEND_ROUTES.has(route.url)) {
      route.bodyLimit = SEND_BODY_LIMIT_BYTES
    }
  })
  return adapter
}
