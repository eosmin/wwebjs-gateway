import type { IncomingMessage } from 'node:http'

import { FastifyAdapter } from '@nestjs/platform-fastify'

import { resolveRequestId } from './logger.config.js'

// Every route takes a body of this size at most; the sends that carry media are raised on their own routes
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024

// The routes that take media as base64 (TDD §6.11 cross-cutting): 32 MiB of file is about 43 MiB of
// base64, and MAX_MEDIA_BYTES is checked on the decoded size, so this is only the ceiling of the body
export const SEND_BODY_LIMIT_BYTES = 40 * 1024 * 1024
export const SEND_ROUTES: ReadonlySet<string> = new Set([
  '/v1/sessions/:sessionId/messages',
  '/v1/sessions/:sessionId/messages/:messageId/reply'
])

// Fastify numbers requests (`req-1`) and pino-http keeps an id that is already set, so the id a caller
// sends in x-request-id has to be chosen here for the logs to carry it
export function createFastifyAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id'])
  })
  adapter.getInstance().addHook('onRoute', route => {
    if (route.method === 'POST' && SEND_ROUTES.has(route.url)) {
      route.bodyLimit = SEND_BODY_LIMIT_BYTES
    }
  })
  return adapter
}
