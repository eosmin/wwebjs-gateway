import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import {
  type HealthIndicatorFunction,
  HealthCheckService,
  HealthIndicatorService
} from '@nestjs/terminus'
import { z } from 'zod'

import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { PrismaService } from '../database/prisma.service.js'
import { RedisService } from '../infra/redis/redis.service.js'
import { HealthResult, type HealthResultDto } from '../types/system.dto.js'
import { isDataPathWritable } from '../whatsapp/data-path.js'

// Where Terminus puts the reason an indicator is down; it goes to the log and nowhere else
const failureReasons = z.object({
  error: z.record(z.string(), z.object({ message: z.string().optional() })).optional()
})

// A dependency that does not answer in time counts as down, so a probe never hangs
const PING_TIMEOUT_MS = 2000

// Runs the health checks of the gateway. Terminus marks the result `shutting_down` from the moment
// the shutdown begins, which is what makes /ready fail while in-flight work drains.
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name)

  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(HealthIndicatorService) private readonly indicators: HealthIndicatorService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'WWEBJS_DATA_PATH'>
  ) {}

  // No dependency is probed: the process answering is the signal
  liveness(): Promise<HealthResultDto> {
    return this.run([])
  }

  // Postgres and Redis answer, and the folder of the saved logins takes files. The attempt callbacks return nothing, because whatever they return is
  // added to the public result.
  readiness(): Promise<HealthResultDto> {
    return this.run([
      () =>
        this.indicators
          .check('postgres')
          .attempt(async () => {
            await this.prisma.$queryRaw`SELECT 1`
          })
          .withTimeout(PING_TIMEOUT_MS),
      () =>
        this.indicators
          .check('redis')
          .attempt(async () => {
            await this.redis.client.ping()
          })
          .withTimeout(PING_TIMEOUT_MS),
      () =>
        this.indicators
          .check('dataPath')
          .attempt(async () => {
            // Without it every session start fails and retries; the reason is a folder, not a dependency
            if (!(await isDataPathWritable(this.config.WWEBJS_DATA_PATH))) {
              throw new Error('The folder of the saved logins is not writable')
            }
          })
          .withTimeout(PING_TIMEOUT_MS)
    ])
  }

  // Terminus reports a failure by throwing a 503 that carries the result; the probes want the
  // result itself, so it is taken back out of the exception
  private async run(checks: HealthIndicatorFunction[]): Promise<HealthResultDto> {
    try {
      return HealthResult.parse(await this.health.check(checks))
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error
      const raw = error.getResponse()
      const result = HealthResult.parse(raw)
      if (result.status !== 'shutting_down') this.logFailure(raw)
      return result
    }
  }

  private logFailure(raw: unknown): void {
    const reasons = failureReasons.safeParse(raw)
    const down = Object.entries(reasons.success ? (reasons.data.error ?? {}) : {})
    this.logger.warn(
      `Health check failed: ${down.map(([name, { message }]) => `${name} (${message ?? 'no reason'})`).join(', ')}`
    )
  }
}
