import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError, UnauthorizedError } from '../common/errors.js'
import { generateToken, sha256Hex } from '../common/lib/crypto.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { InboundHook } from '../database/models.js'
import { InboundHooksRepository } from '../database/repositories/inbound-hooks.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { CreatedInboundHookDto, InboundHookDto } from '../types/inbound-hooks.dto.js'

export const INBOUND_HOOK_PATH = '/v1/hooks/inbound/'

// 32 random bytes in base64url: a token of any other shape cannot be one of ours, so it is refused
// without reading the database
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

// What a token stands for once it is accepted
export interface InboundHookGrant {
  hookId: string
  sessionId: string
}

export function toInboundHookDto(row: InboundHook): InboundHookDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString()
  }
}

// The inbound hooks of a session: a secret URL that lets another system send a message through the
// session. Only the sha256 of the token is stored, so the URL exists in the answer of `create` and
// nowhere else. The routes check that the key reaches the session; this service trusts that.
@Injectable()
export class InboundHookService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(InboundHooksRepository) private readonly hooks: InboundHooksRepository,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository
  ) {}

  async create(sessionId: string, name: string): Promise<CreatedInboundHookDto> {
    if ((await this.sessions.findById(sessionId)) === null) throw sessionNotFound(sessionId)
    const token = generateToken()
    // The session can be deleted between the check above and the insert; the foreign key says so
    const row = await this.hooks.create({ sessionId, name, tokenHash: sha256Hex(token) })
    if (row === null) throw sessionNotFound(sessionId)
    return { ...toInboundHookDto(row), url: this.urlFor(token) }
  }

  async list(sessionId: string): Promise<InboundHookDto[]> {
    return (await this.hooks.listForSession(sessionId)).map(toInboundHookDto)
  }

  // Revoking is final and repeatable. A hook of another session is "not found", so an id does not
  // tell a key of one session that the hook exists in another.
  async revoke(sessionId: string, hookId: string): Promise<InboundHookDto> {
    const row = await this.hooks.findById(hookId)
    if (row?.sessionId !== sessionId) throw hookNotFound(hookId)
    const revoked = await this.hooks.revoke(hookId, new Date())
    if (revoked === null) throw hookNotFound(hookId)
    return toInboundHookDto(revoked)
  }

  // The hook behind a token. An unknown token, a malformed one and a revoked one all answer the same
  // 401, so the answer says nothing about which tokens exist. The lookup is by the sha256 of the
  // token, an indexed equality on a digest, so it leaks nothing through its timing; nothing is
  // cached, so a revoked hook stops at once.
  async resolve(token: string): Promise<InboundHookGrant> {
    if (!TOKEN_PATTERN.test(token)) throw invalidToken()
    const row = await this.hooks.findByTokenHash(sha256Hex(token))
    if (row === null || row.revokedAt !== null) throw invalidToken()
    return { hookId: row.id, sessionId: row.sessionId }
  }

  private urlFor(token: string): string {
    // The gateway may sit under a path prefix behind a reverse proxy, so the route is appended to
    // the base, not resolved against it
    return `${this.config.PUBLIC_BASE_URL.replace(/\/+$/, '')}${INBOUND_HOOK_PATH}${token}`
  }
}

const invalidToken = (): UnauthorizedError => new UnauthorizedError('UNAUTHORIZED')

const hookNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Inbound hook "${id}" does not exist`)

const sessionNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Session "${id}" does not exist`)
