import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit
} from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { z } from 'zod'

import { retry } from '../common/lib/retry.js'
import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { PrismaClient } from '../generated/prisma/client.js'

// Postgres may still be starting when the gateway boots (compose, a restart of the host), so the
// first connection is retried with backoff instead of crashing the process
const CONNECT_ATTEMPTS = 8
const CONNECT_BASE_DELAY_MS = 250
const CONNECT_MAX_DELAY_MS = 5000
// The pool waits forever by default: without a bound, an address that never answers would hang the
// boot inside one attempt and the retry loop above would never get to count it
const CONNECT_TIMEOUT_MS = 5000
const DISCONNECT_TIMEOUT_MS = 5000

// Retrying cannot fix these: the credentials or the database name are wrong. The list is minimal on
// purpose: any other kind is retried, which only costs time before the boot fails
const PERMANENT_FAILURES = ['AuthenticationFailed', 'DatabaseDoesNotExist']

// The shape Prisma gives a failure of the pg driver adapter
const driverFailure = z.object({
  meta: z.object({ driverAdapterError: z.object({ cause: z.object({ kind: z.string() }) }) })
})

function failureKind(error: unknown): string | undefined {
  const parsed = driverFailure.safeParse(error)
  return parsed.success ? parsed.data.meta.driverAdapterError.cause.kind : undefined
}

// A Prisma message is the invocation, a blank line and then the reason; the reason is empty when the
// connection is refused, and then the code on the error (ECONNREFUSED) is all there is to say.
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error'
  const lines = error.message.split('\n').filter(line => line.trim() !== '')
  const last = lines.at(-1) ?? ''
  const reason = last.endsWith('invocation:') ? '' : last
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  return scrubCredentials(reason || code || 'unknown error')
}

// Whatever the driver echoed of a connection string: the user and password of a URL (up to the
// last @ before the host, so a raw @ in the password goes too), a password= pair of a keyword/value
// string or of a query string
function scrubCredentials(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/)[^\s/]*@/gi, '$1<redacted>@')
    .replace(/(password=)[^\s&]+/gi, '$1<redacted>')
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name)

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.DATABASE_URL,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS
      })
    })
  }

  async onModuleInit(): Promise<void> {
    try {
      await retry(
        async attempt => {
          try {
            await this.$connect()
            // With a driver adapter $connect does not open a socket, so a real query proves the link
            await this.$queryRaw`SELECT 1`
          } catch (error) {
            this.logger.warn(
              `Postgres connection attempt ${attempt} failed: ${describeFailure(error)}`
            )
            throw error
          }
        },
        {
          attempts: CONNECT_ATTEMPTS,
          baseDelayMs: CONNECT_BASE_DELAY_MS,
          maxDelayMs: CONNECT_MAX_DELAY_MS,
          shouldRetry: error => !PERMANENT_FAILURES.includes(failureKind(error) ?? '')
        }
      )
    } catch (error) {
      // Nest does not run onModuleDestroy when init throws, so the pool is released here
      await this.$disconnect().catch(() => undefined)
      throw error
    }
  }

  // Runs after the queues and workers that use the client have closed (onModuleDestroy would run
  // before them), so nothing writes to a closed pool. Bounded, so a stuck pool cannot hold the exit.
  async onApplicationShutdown(): Promise<void> {
    try {
      await withTimeout(this.$disconnect(), DISCONNECT_TIMEOUT_MS, 'postgres disconnect')
    } catch {
      this.logger.warn('Postgres did not disconnect cleanly, giving up')
    }
  }
}
