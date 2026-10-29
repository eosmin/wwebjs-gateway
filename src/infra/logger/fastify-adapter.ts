import type { IncomingMessage } from 'node:http'

import { FastifyAdapter } from '@nestjs/platform-fastify'

import { resolveRequestId } from './logger.config.js'

// Every route takes a body of this size at most; the sends that carry media are raised on their own routes
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024

// Fastify numbers requests (`req-1`) and pino-http keeps an id that is already set, so the id a caller
// sends in x-request-id has to be chosen here for the logs to carry it
export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id'])
  })
}
