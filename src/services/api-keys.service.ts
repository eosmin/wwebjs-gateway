import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError, ValidationError } from '../common/errors.js'
import { generateApiKey } from '../common/lib/crypto.js'
import { DEFAULT_KEY_SCOPES, KEY_SCOPES } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { ApiKey } from '../database/models.js'
import { type NewApiKey, ApiKeysRepository } from '../database/repositories/api-keys.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type {
  ApiKeyDto,
  CreateApiKeyDto,
  CreatedApiKeyDto,
  RotatedApiKeyDto
} from '../types/api-keys.dto.js'

import { AuthService } from './auth.service.js'

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString())

export function toApiKeyDto(row: ApiKey): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    sessionId: row.sessionId,
    scopes: row.scopes,
    allowedCidrs: row.allowedCidrs,
    expiresAt: iso(row.expiresAt),
    rotatedFromId: row.rotatedFromId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt)
  }
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ApiKeysRepository) private readonly apiKeys: ApiKeysRepository,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  async list(): Promise<ApiKeyDto[]> {
    return (await this.apiKeys.list()).map(toApiKeyDto)
  }

  // The raw key is in the answer and nowhere else: only its hash is stored
  async create(input: CreateApiKeyDto): Promise<CreatedApiKeyDto> {
    const now = Date.now()
    // A key with no session is an admin key whatever its scopes say; accepting scopes here would
    // let a caller believe the key is restricted
    if (input.sessionId === undefined && input.scopes !== undefined) {
      throw new ValidationError('VALIDATION_ERROR', 'scopes only apply to a key with a sessionId')
    }
    if (input.sessionId !== undefined && (await this.sessions.findById(input.sessionId)) === null) {
      throw new NotFoundError('NOT_FOUND', `Session "${input.sessionId}" does not exist`)
    }
    const generated = generateApiKey()
    const row = await this.createRow({
      name: input.name,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      sessionId: input.sessionId ?? null,
      // An admin key passes every scope, so listing it with all of them says what it can do
      scopes:
        input.sessionId === undefined ? [...KEY_SCOPES] : (input.scopes ?? [...DEFAULT_KEY_SCOPES]),
      allowedCidrs: input.allowedCidrs ?? [],
      expiresAt: this.resolveExpiry(input.expiresAt, now)
    })
    return { ...toApiKeyDto(row), key: generated.raw }
  }

  // The session can be deleted between the check above and the insert; the foreign key says so
  private async createRow(data: NewApiKey): Promise<ApiKey> {
    const row = await this.apiKeys.create(data)
    if (row === null) {
      throw new NotFoundError('NOT_FOUND', `Session "${data.sessionId ?? ''}" does not exist`)
    }
    return row
  }

  // Issues a key with the same name, session, scopes and addresses, and lets the old one live for
  // the grace period, so a consumer swaps the secret without downtime
  async rotate(id: string): Promise<RotatedApiKeyDto> {
    const now = Date.now()
    const generated = generateApiKey()
    const graceEnd = new Date(now + this.config.API_KEY_ROTATION_GRACE_MINUTES * MS_PER_MINUTE)
    let previousExpiresAt = graceEnd
    // The builder runs inside the transaction, on the row it read there. It is run again when the
    // transaction is retried, so the date is assigned, not accumulated.
    const created = await this.apiKeys.rotate(
      id,
      current => {
        previousExpiresAt =
          current.expiresAt !== null && current.expiresAt < graceEnd ? current.expiresAt : graceEnd
        return {
          name: current.name,
          keyHash: generated.hash,
          keyPrefix: generated.prefix,
          sessionId: current.sessionId,
          scopes: current.scopes,
          allowedCidrs: current.allowedCidrs,
          expiresAt: this.rotatedExpiry(current.expiresAt, now)
        }
      },
      graceEnd
    )
    if (created === null) throw keyNotFound(id)

    this.auth.invalidate(id)
    return {
      ...toApiKeyDto(created),
      key: generated.raw,
      previousKeyExpiresAt: previousExpiresAt.toISOString()
    }
  }

  async revoke(id: string): Promise<ApiKeyDto> {
    const row = await this.apiKeys.revoke(id, new Date())
    if (row === null) throw keyNotFound(id)
    this.auth.invalidate(id)
    return toApiKeyDto(row)
  }

  // An expiry the owner chose carries over, never beyond the cap in force now; a key with none, or
  // one that already lapsed, gets the cap (or none when there is no cap)
  private rotatedExpiry(previous: Date | null, now: number): Date | null {
    const fresh = this.resolveExpiry(undefined, now)
    if (previous === null || previous.getTime() <= now) return fresh
    return fresh !== null && fresh < previous ? fresh : previous
  }

  // API_KEY_MAX_TTL_DAYS caps the lifetime: a key without an expiry gets the longest one allowed,
  // and a date beyond it is refused instead of being silently shortened
  private resolveExpiry(requested: string | undefined, now: number): Date | null {
    const maxDays = this.config.API_KEY_MAX_TTL_DAYS
    const limit = maxDays > 0 ? now + maxDays * MS_PER_DAY : null
    if (requested === undefined) return limit === null ? null : new Date(limit)
    const expiresAt = new Date(requested)
    if (expiresAt.getTime() <= now) {
      throw new ValidationError('VALIDATION_ERROR', 'expiresAt must be in the future')
    }
    if (limit !== null && expiresAt.getTime() > limit) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        `expiresAt is beyond the longest lifetime allowed (${maxDays} days)`,
        { maxDays }
      )
    }
    return expiresAt
  }
}

function keyNotFound(id: string): NotFoundError {
  return new NotFoundError('NOT_FOUND', `API key "${id}" does not exist`)
}
