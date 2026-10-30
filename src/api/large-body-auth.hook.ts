import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { ThrottlerStorage, normalizeIp } from '@nestjs/throttler'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { AppError } from '../common/errors.js'
import { describeException, type ErrorBody } from '../common/filters/all-exceptions.filter.js'
import { extractApiKey } from '../common/guards/api-key.guard.js'
import { type CountedRequest, RATE_LIMIT_WINDOW_MS } from '../common/guards/rate-limit.js'
import { requestClientIp } from '../common/lib/client-ip.js'
import { assertScope, assertSessionAccess } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { DEFAULT_BODY_LIMIT_BYTES, SEND_ROUTES } from '../infra/logger/fastify-adapter.js'
import { REQUEST_ID_HEADER } from '../infra/logger/logger.config.js'
import { AuthService } from '../services/auth.service.js'

const RATE_LIMIT_SECONDS = RATE_LIMIT_WINDOW_MS / 1000

// Fastify reads the whole body of a route before any Nest guard runs, so the 40 MiB the send routes
// accept would be buffered for whoever asks, key or not. This hook runs first (`onRequest`): a body
// that fits what every other route takes goes the normal way, and a larger one, or one that does not
// say its size, is paid for with a bucket of the address and an API key that may send in that session.
// The guards check the same things again later; this only decides whether the body is read at all.
@Injectable()
export class LargeBodyAuthHook implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  onModuleInit(): void {
    const { httpAdapter } = this.host
    if (httpAdapter === undefined) return
    httpAdapter
      .getInstance<FastifyInstance>()
      .addHook('onRequest', async (request, reply) => this.check(request, reply))
  }

  private async check(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.method !== 'POST' || !SEND_ROUTES.has(request.routeOptions.url ?? '')) return
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared <= DEFAULT_BODY_LIMIT_BYTES) return
    try {
      await this.admit(request)
    } catch (error: unknown) {
      const { status, ...described } = describeException(
        error,
        this.config.NODE_ENV === 'production'
      )
      const body: ErrorBody = { error: { ...described, requestId: request.id } }
      void reply.header(REQUEST_ID_HEADER, request.id)
      if (error instanceof AppError && error.code === 'RATE_LIMITED') {
        void reply.header('retry-after', error.details?.['retryAfterSeconds'] ?? RATE_LIMIT_SECONDS)
      }
      await reply.status(status).send(body)
    }
  }

  private async admit(request: FastifyRequest): Promise<void> {
    const ip = requestClientIp(request, this.config.TRUST_PROXY_HOPS)
    // The same bucket the RateLimitGuard fills, so a flood of large bodies is limited like any other
    const record = await this.storage.increment(
      `ip:${normalizeIp(ip)}`,
      RATE_LIMIT_WINDOW_MS,
      this.config.RATE_LIMIT_MAX,
      0,
      'ip'
    )
    if (record.totalHits > this.config.RATE_LIMIT_MAX) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSeconds: record.timeToExpire })
    }
    // The RateLimitGuard skips its own address bucket for this request: it was counted here
    const counted: CountedRequest = request
    counted.ipRateCounted = true
    const principal = await this.auth.authenticate(extractApiKey(request), ip)
    assertScope(principal, 'send')
    const { sessionId } = (request.params ?? {}) as { sessionId?: unknown }
    if (typeof sessionId === 'string') assertSessionAccess(principal, sessionId)
  }
}
