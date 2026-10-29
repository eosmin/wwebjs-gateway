import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { FastifyAdapter } from '@bull-board/fastify'
import { HttpStatus } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { normalizeIp } from '@nestjs/throttler'
import type { Queue } from 'bullmq'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requestClientIp } from '../common/lib/client-ip.js'
import { safeEqual } from '../common/lib/crypto.js'
import type { AppConfig } from '../config/env.schema.js'

export const BULL_BOARD_PATH = '/admin/queues'
export const BULL_BOARD_USER = 'admin'

// A browser cannot send X-API-Key, so the dashboard asks for HTTP Basic credentials: this user and
// the admin key as the password. Failures are counted per address, because this route does not go
// through the guards of the API.
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 60_000

// What the dashboard's own page needs; the policy of the API (helmet) stays as it is everywhere else
const BOARD_CSP = [
  `default-src 'self'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data:`,
  `script-src 'self' 'unsafe-inline'`,
  `connect-src 'self'`,
  // 'none' would make the browser ignore the <base href> the dashboard uses to find its assets
  `base-uri 'self'`,
  `form-action 'self'`,
  `object-src 'none'`,
  `frame-ancestors 'none'`
].join('; ')

export interface QueueSource {
  // Calls the listener with the queues now and again whenever they change; returns the way to stop
  watchQueues: (listener: (queues: Queue[]) => void) => () => void
}

function credentialsOf(request: FastifyRequest): { user: string; password: string } | undefined {
  const header = request.headers.authorization
  if (header === undefined || !/^basic /i.test(header)) return undefined
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) return undefined
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

class FailureLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>()

  isBlocked(address: string, now: number): boolean {
    const entry = this.failures.get(address)
    if (!entry) return false
    if (entry.resetAt <= now) {
      this.failures.delete(address)
      return false
    }
    return entry.count >= MAX_FAILURES
  }

  record(address: string, now: number): void {
    this.sweep(now)
    const entry = this.failures.get(address)
    if (!entry || entry.resetAt <= now) {
      this.failures.set(address, { count: 1, resetAt: now + FAILURE_WINDOW_MS })
      return
    }
    entry.count += 1
  }

  // Addresses that stopped trying are forgotten, so the map cannot grow without bound
  private sweep(now: number): void {
    for (const [address, entry] of this.failures) {
      if (entry.resetAt <= now) this.failures.delete(address)
    }
  }
}

function authenticator(adminKey: string, trustedHops: number) {
  const limiter = new FailureLimiter()
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now()
    // The address the proxies saw, as the rest of the API counts it
    const address = normalizeIp(requestClientIp(request, trustedHops))
    if (limiter.isBlocked(address, now)) {
      await reply
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .header('retry-after', '60')
        .send({ error: 'Too many attempts' })
      return
    }
    const given = credentialsOf(request)
    // Both comparisons always run, so the answer does not tell which half was wrong
    const userOk = safeEqual(given?.user ?? '', BULL_BOARD_USER)
    const passwordOk = safeEqual(given?.password ?? '', adminKey)
    // A good login does not clear the count: the window ends by itself, so someone else's sign in
    // cannot give a guesser sharing the address a fresh set of attempts
    if (userOk && passwordOk) return
    limiter.record(address, now)
    await reply
      .status(HttpStatus.UNAUTHORIZED)
      .header('www-authenticate', 'Basic realm="Send queues", charset="UTF-8"')
      .send({ error: 'Unauthorized' })
  }
}

// Mounts the Bull Board dashboard at /admin/queues when BULL_BOARD_ENABLED=true; nothing is
// registered otherwise, so the route answers 404. The queues are created while the application
// runs (one per session), so the board follows the source instead of taking a fixed list.
export async function setupBullBoard(
  app: NestFastifyApplication,
  config: Pick<AppConfig, 'BULL_BOARD_ENABLED' | 'ADMIN_API_KEY' | 'TRUST_PROXY_HOPS'>,
  source: QueueSource
): Promise<void> {
  if (!config.BULL_BOARD_ENABLED) return
  const serverAdapter = new FastifyAdapter()
  serverAdapter.setBasePath(BULL_BOARD_PATH)
  const board = createBullBoard({ queues: [], serverAdapter })
  source.watchQueues(queues => board.replaceQueues(queues.map(queue => new BullMQAdapter(queue))))

  const authenticate = authenticator(config.ADMIN_API_KEY, config.TRUST_PROXY_HOPS)
  await app.register(async (scope: FastifyInstance) => {
    scope.addHook('onRequest', authenticate)
    scope.addHook('onSend', (_request, reply, payload, done) => {
      // Job data holds message text and numbers: the browser keeps none of it
      void reply.header('content-security-policy', BOARD_CSP).header('cache-control', 'no-store')
      done(null, payload)
    })
    await scope.register(serverAdapter.registerPlugin(), { prefix: BULL_BOARD_PATH })
  })
}
