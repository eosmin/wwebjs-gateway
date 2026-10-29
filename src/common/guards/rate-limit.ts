import { type ExecutionContext, Injectable } from '@nestjs/common'
import { ThrottlerGuard, normalizeIp, type ThrottlerModuleOptions } from '@nestjs/throttler'
import type { FastifyRequest } from 'fastify'

import type { AppConfig } from '../../config/env.schema.js'
import { requestClientIp } from '../lib/client-ip.js'
import { sha256Hex } from '../lib/crypto.js'

import { extractApiKey } from './api-key.guard.js'

export const RATE_LIMIT_WINDOW_MS = 60_000
const KEY_THROTTLER = 'key'
const IP_THROTTLER = 'ip'

const requestOf = (context: ExecutionContext): FastifyRequest =>
  context.switchToHttp().getRequest<FastifyRequest>()

// The address is normalized (an IPv4-mapped IPv6 address is its IPv4 one, an IPv6 address counts as its /64),
// so a caller cannot get a fresh bucket by rotating the low bits of its address.
// Two buckets per request, both of RATE_LIMIT_MAX a minute. The address one comes first and covers every
// route, the public ones and the failed authentications included: an unknown key costs a database
// lookup, and a caller who invents a new key per request would get a fresh key bucket each time, so only
// the address bounds it. The key one lets a client with several addresses keep its own allowance. It is
// not an authentication: the tracker is the hash of whatever key the request carries.
export function buildRateLimitOptions(
  config: Pick<AppConfig, 'RATE_LIMIT_MAX' | 'TRUST_PROXY_HOPS'>
): ThrottlerModuleOptions {
  const limit = config.RATE_LIMIT_MAX
  return {
    throttlers: [
      {
        name: IP_THROTTLER,
        ttl: RATE_LIMIT_WINDOW_MS,
        limit,
        getTracker: req =>
          normalizeIp(requestClientIp(req as FastifyRequest, config.TRUST_PROXY_HOPS)) // reason: the guard hands over the Fastify request
      },
      {
        name: KEY_THROTTLER,
        ttl: RATE_LIMIT_WINDOW_MS,
        limit,
        skipIf: context => extractApiKey(requestOf(context)) === undefined,
        getTracker: req => sha256Hex(extractApiKey(req as FastifyRequest) ?? '') // reason: skipIf already dropped a request with no key
      }
    ],
    // The default key includes the controller and the handler, which would make the allowance per route
    generateKey: (_context, tracker, name) => `${name}:${tracker}`,
    errorMessage: 'Too many requests; retry after the number of seconds in the Retry-After header'
  }
}

// A named throttler suffixes its headers (`Retry-After-ip`, `X-RateLimit-Limit-key`); a client looks for
// the plain Retry-After, and nothing else is worth sending
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override setResponseHeader(
    res: Record<string, unknown>,
    name: string,
    value: string | number
  ): void {
    if (name.startsWith('Retry-After')) super.setResponseHeader(res, 'Retry-After', value)
  }
}
