import type { IncomingMessage } from 'node:http'

import { FastifyAdapter } from '@nestjs/platform-fastify'

import { resolveRequestId } from './logger.config.js'

// Fastify numbers requests (`req-1`) and pino-http keeps an id that is already set, so the id a caller
// sends in x-request-id has to be chosen here for the logs to carry it
export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id'])
  })
}
