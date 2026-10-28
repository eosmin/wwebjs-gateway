import type { BlockList } from 'node:net'

import { Inject, Injectable, Logger } from '@nestjs/common'

import { UnauthorizedError, ForbiddenError } from '../common/errors.js'
import { buildCidrList, ipInList } from '../common/lib/cidr.js'
import { safeEqual, sha256Hex } from '../common/lib/crypto.js'
import { type Principal, adminPrincipal, keyPrincipal } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { ApiKey } from '../database/models.js'
import { ApiKeysRepository } from '../database/repositories/api-keys.repository.js'

// A revoked key stays usable for at most this long on a gateway that did not see the revoke
const CACHE_TTL_MS = 30_000
// A key is stamped with its last use at most once per interval
const LAST_USED_INTERVAL_MS = 60_000

interface CachedKey {
  row: ApiKey
  // Built once per row, not per request; null when the key has no allowlist
  cidrs: BlockList | null
  cachedUntil: number
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)
  private readonly cache = new Map<string, CachedKey>()
  private readonly lastStamped = new Map<string, number>()
  // Bumped by invalidate(): a row read before the bump may already be stale, so it is not cached
  private generation = 0

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ApiKeysRepository) private readonly apiKeys: ApiKeysRepository
  ) {}

  // Resolves a raw key and the address it came from to a principal, or throws. The environment key
  // is compared in constant time and is not subject to an address list.
  async authenticate(rawKey: string | undefined, clientIp: string): Promise<Principal> {
    if (rawKey === undefined || rawKey === '') throw unauthorized()
    if (safeEqual(rawKey, this.config.ADMIN_API_KEY)) return adminPrincipal(null)

    const cached = await this.find(sha256Hex(rawKey))
    if (cached === null) throw unauthorized()
    const { row } = cached
    const now = Date.now()
    if (row.revokedAt !== null) throw unauthorized()
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now) {
      throw new UnauthorizedError('API_KEY_EXPIRED')
    }
    if (cached.cidrs !== null && !ipInList(cached.cidrs, clientIp)) {
      throw new ForbiddenError('IP_NOT_ALLOWED', undefined, { ip: clientIp })
    }
    this.stampLastUsed(row.id, now)
    // A database key with no session is an admin key
    return row.sessionId === null
      ? adminPrincipal(row.id)
      : keyPrincipal(row.id, row.sessionId, row.scopes)
  }

  // The revoke and rotate paths call it so the change does not wait for the cache to expire
  invalidate(keyId: string): void {
    this.generation += 1
    this.lastStamped.delete(keyId)
    for (const [hash, cached] of this.cache) {
      if (cached.row.id === keyId) this.cache.delete(hash)
    }
  }

  private async find(keyHash: string): Promise<CachedKey | null> {
    const hit = this.cache.get(keyHash)
    if (hit !== undefined && hit.cachedUntil > Date.now()) return hit
    this.cache.delete(keyHash)
    const generation = this.generation
    const row = await this.apiKeys.findByHash(keyHash)
    // An unknown key is not cached: the map holds only keys that exist
    if (row === null) return null
    const cached: CachedKey = {
      row,
      cidrs: row.allowedCidrs.length === 0 ? null : buildCidrList(row.allowedCidrs),
      cachedUntil: Date.now() + CACHE_TTL_MS
    }
    // Used for this request, but not kept when an invalidate ran while the row was being read
    if (generation === this.generation) this.cache.set(keyHash, cached)
    return cached
  }

  // Not awaited: a slow write must not slow the request, and a failed one only loses a timestamp
  private stampLastUsed(keyId: string, now: number): void {
    const last = this.lastStamped.get(keyId)
    if (last !== undefined && now - last < LAST_USED_INTERVAL_MS) return
    this.lastStamped.set(keyId, now)
    this.apiKeys.touchLastUsed(keyId, new Date(now)).catch((error: unknown) => {
      this.logger.warn(`Could not stamp the last use of an API key: ${errorKind(error)}`)
    })
  }
}

function unauthorized(): UnauthorizedError {
  return new UnauthorizedError('UNAUTHORIZED')
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
