import { Inject, Injectable } from '@nestjs/common'

import {
  ConflictError,
  NotFoundError,
  ServiceBusyError,
  UnauthorizedError
} from '../common/errors.js'
import { generateToken, sha256Hex } from '../common/lib/crypto.js'
import { KeyedLock } from '../common/lib/keyed-lock.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { InboundHook } from '../database/models.js'
import { InboundHooksRepository } from '../database/repositories/inbound-hooks.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { CreatedInboundHookDto, InboundHookDto } from '../types/inbound-hooks.dto.js'

export const INBOUND_HOOK_PATH = '/v1/hooks/inbound/'

const SEND_WINDOW_MS = 60_000

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
  // The creations of one session go one after another, so the count and the insert are one step
  private readonly creating = new KeyedLock()
  // When each hook took its last sends, inside the window; the gateway runs a single instance
  private readonly sends = new Map<string, number[]>()
  private sweptAt = 0

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(InboundHooksRepository) private readonly hooks: InboundHooksRepository,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository
  ) {}

  async create(sessionId: string, name: string): Promise<CreatedInboundHookDto> {
    if ((await this.sessions.findById(sessionId)) === null) throw sessionNotFound(sessionId)
    const token = generateToken()
    // Every active hook is a secret URL that sends through the session, so the number is bounded
    const row = await this.creating.run(sessionId, async () => {
      const limit = this.config.WEBHOOKS_MAX_PER_SESSION
      if ((await this.hooks.countActiveForSession(sessionId)) >= limit) {
        throw new ConflictError(
          'MAX_INBOUND_HOOKS_REACHED',
          `The session already has ${limit} active inbound hooks, the most it can have`
        )
      }
      return this.hooks.create({ sessionId, name, tokenHash: sha256Hex(token) })
    })
    // The session can be deleted between the check above and the insert; the foreign key says so
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

  // Counts one request of the hook against its allowance of INBOUND_HOOK_MAX_PER_MINUTE. It comes
  // after `resolve`, so only real hooks have an entry; the address allowance stops the callers that
  // invent tokens. A sliding window: the hook can send again when its oldest request leaves it.
  admitSend(hookId: string): void {
    const now = Date.now()
    const recent = (this.sends.get(hookId) ?? []).filter(at => now - at < SEND_WINDOW_MS)
    const oldest = recent[0]
    const limit = this.config.INBOUND_HOOK_MAX_PER_MINUTE
    if (oldest !== undefined && recent.length >= limit) {
      this.sends.set(hookId, recent)
      throw new ServiceBusyError(
        'RATE_LIMITED',
        Math.ceil((oldest + SEND_WINDOW_MS - now) / 1000),
        true,
        `An inbound hook accepts ${limit} messages a minute`
      )
    }
    this.sends.set(hookId, [...recent, now])
    if (now - this.sweptAt >= SEND_WINDOW_MS) this.sweepSends(now)
  }

  // Once a window at most, so a request never pays for the whole table: a hook that stopped sending
  // (a revoked one too) leaves it within two windows
  private sweepSends(now: number): void {
    this.sweptAt = now
    for (const [id, times] of this.sends) {
      if (times.every(at => now - at >= SEND_WINDOW_MS)) this.sends.delete(id)
    }
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
