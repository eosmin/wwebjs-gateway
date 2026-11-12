import type { Server } from 'node:http'

import helmet from '@fastify/helmet'
import { HttpStatus } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { FastifyInstance } from 'fastify'

import { ErrorCode } from '../../common/errors.js'
import { hasNul } from '../../common/lib/nul.js'
import type { AppConfig } from '../../config/env.schema.js'
import { REQUEST_ID_HEADER } from '../logger/logger.config.js'

// What Swagger UI needs from the content security policy; the policy is not relaxed when the docs are off
const DOCS_CSP = {
  directives: {
    defaultSrc: [`'self'`],
    styleSrc: [`'self'`, `'unsafe-inline'`],
    imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
    scriptSrc: [`'self'`, 'https:', `'unsafe-inline'`]
  }
}

// Security headers and CORS. Called by main.ts before the application listens.
export async function setupHttp(
  app: NestFastifyApplication,
  config: Pick<AppConfig, 'CORS_ORIGINS' | 'ENABLE_DOCS'>
): Promise<void> {
  rejectNul(app.getHttpAdapter().getInstance())
  await app.register(helmet, config.ENABLE_DOCS ? { contentSecurityPolicy: DOCS_CSP } : {})
  // No origin listed: the browser same-origin policy applies, which is what a server-to-server API wants
  if (config.CORS_ORIGINS.length > 0) {
    app.enableCors({
      origin: config.CORS_ORIGINS,
      exposedHeaders: [REQUEST_ID_HEADER, 'retry-after']
    })
  }
}

// Postgres cannot store U+0000, so a request that carries one in its body, query or params would
// fail deep in a repository as a 500. It is answered 400 here, after the body is parsed and before
// any controller or pipe sees it.
function rejectNul(instance: FastifyInstance): void {
  instance.addHook('preValidation', async (request, reply) => {
    if (!hasNul(request.body) && !hasNul(request.query) && !hasNul(request.params)) return
    void reply.header(REQUEST_ID_HEADER, request.id)
    return reply.status(HttpStatus.BAD_REQUEST).send({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'The request contains a NUL (U+0000) character, which is not allowed',
        requestId: request.id
      }
    })
  })
}

// Fastify leaves every one of these off, so a client that declares a body (Content-Length) and then
// stops sending would hold its socket, and the memory of the partial body, for ever. They are set on
// the Node server itself: `requestTimeout` closes a request that is not complete in time, so it
// bounds the upload (the largest body, about 40 MiB with media, needs a client faster than
// 40 MiB / HTTP_REQUEST_TIMEOUT_MS), `headersTimeout` the wait for the headers. `timeout` (the idle
// time of a connection) stays off unless asked for, because a connection that waits for the answer
// of a slow call is silent too. Node looks at them every 30 s, so a stalled request ends within that
// margin after its limit.
export function applyServerTimeouts(
  server: Server,
  config: Pick<
    AppConfig,
    'HTTP_REQUEST_TIMEOUT_MS' | 'HTTP_HEADERS_TIMEOUT_MS' | 'HTTP_CONNECTION_TIMEOUT_MS'
  >
): void {
  server.requestTimeout = config.HTTP_REQUEST_TIMEOUT_MS
  server.headersTimeout = config.HTTP_HEADERS_TIMEOUT_MS
  server.setTimeout(config.HTTP_CONNECTION_TIMEOUT_MS)
}
