import { Controller, Get, HttpStatus, Inject, Req, Res } from '@nestjs/common'
import { ApiOkResponse, ApiServiceUnavailableResponse } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'

import { Public } from '../../common/decorators/auth.decorators.js'
import { ForbiddenError } from '../../common/errors.js'
import { type AuthenticatedRequest, extractApiKey } from '../../common/guards/api-key.guard.js'
import { requestClientIp } from '../../common/lib/client-ip.js'
import { safeEqual } from '../../common/lib/crypto.js'
import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import { MetricsService } from '../../infra/metrics/metrics.service.js'
import { AuthService } from '../../services/auth.service.js'
import { ReadinessService } from '../../services/readiness.service.js'
import { HealthResultDto } from '../../types/system.dto.js'

const BEARER = /^Bearer\s+(\S+)$/i

// Probes and the scrape endpoint are hand-written: none of them is a capability of the registry
@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  // Liveness: the process answers. It does not look at Postgres or Redis, so an orchestrator does
  // not restart a process that only needs its dependencies back, and it stays 200 during shutdown.
  @Get('health')
  @ApiOkResponse({ type: HealthResultDto })
  liveness(): Promise<HealthResultDto> {
    return this.readiness.liveness()
  }

  // Readiness: Postgres and Redis answer and the gateway is not shutting down
  @Get('ready')
  @ApiOkResponse({ type: HealthResultDto })
  @ApiServiceUnavailableResponse({ type: HealthResultDto })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthResultDto> {
    const result = await this.readiness.readiness()
    if (result.status !== 'ok' && result.status !== 'degraded') {
      void reply.status(HttpStatus.SERVICE_UNAVAILABLE)
    }
    return result
  }

  // Public for the guard, which only knows API keys: the scrape token is checked here. An admin
  // key also reads it.
  @Get('metrics')
  async scrape(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    await this.assertMayScrape(request)
    void reply.header('content-type', this.metrics.contentType)
    return this.metrics.scrape()
  }

  private async assertMayScrape(request: AuthenticatedRequest): Promise<void> {
    const token = this.config.METRICS_TOKEN
    const bearer = BEARER.exec(request.headers.authorization ?? '')?.[1]
    if (token !== undefined && bearer !== undefined && safeEqual(bearer, token)) return

    const principal = await this.auth.authenticate(
      extractApiKey(request),
      requestClientIp(request, this.config.TRUST_PROXY_HOPS)
    )
    if (!principal.isAdmin) {
      throw new ForbiddenError('INSUFFICIENT_SCOPE', 'Only an admin key can read the metrics', {
        scope: 'admin'
      })
    }
  }
}
