import { Inject, Injectable } from '@nestjs/common'

import { AppError, UnprocessableError } from '../common/errors.js'
import { isWaId, parseRecipient } from '../common/lib/wa-id.js'
import { RedisService } from '../infra/redis/redis.service.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { SendPolicyService } from './send-policy.service.js'

const REGISTERED_TTL_SECONDS = 3600
// A "no" is kept shorter: a wrong one (WhatsApp Web answering null while it is busy) blocks every
// session from that number until it expires
const NOT_REGISTERED_TTL_SECONDS = 300
// A number that is not on WhatsApp is stored as this, so asking again soon costs nothing
const NOT_REGISTERED = ''

// Turns the `to` of a request into the WhatsApp id the send needs. A full id is used as it is; a
// phone number is looked up with `getNumberId`, and the answer is cached for an hour. Whether a
// number is registered does not depend on the account asking, so the cache is shared by sessions.
@Injectable()
export class RecipientResolverService {
  constructor(
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(SendPolicyService) private readonly policy: SendPolicyService,
    @Inject(RedisService) private readonly redis: RedisService
  ) {}

  async resolve(sessionId: string, to: string): Promise<string> {
    const recipient = parseRecipient(to)
    if (recipient.kind === 'id') return recipient.id
    const id = await this.lookup(sessionId, recipient.digits)
    if (id === null) throw this.notRegistered()
    return id
  }

  // The WhatsApp id of a phone number, or null when it is not registered. A cached answer costs
  // nothing; a look-up counts against LOOKUPS_PER_DAY.
  async lookup(sessionId: string, digits: string): Promise<string | null> {
    const key = `numid:${digits}`
    const cached = await this.redis.client.get(key)
    // A value that is neither "no" nor an id is not ours: it is looked up again
    if (cached === NOT_REGISTERED) return null
    if (cached !== null && isWaId(cached)) return cached

    const client = this.sessions.requireReady(sessionId)
    // Many look-ups of numbers that are not on WhatsApp are a signal in themselves
    const admitted = await this.policy.admitLookup(sessionId)
    if (admitted.decision === 'reject') {
      throw new AppError(admitted.code, undefined, { rule: admitted.rule })
    }
    if (admitted.decision === 'delay') {
      throw new AppError('POLICY_BLOCKED', 'Too many number look-ups right now; try again later', {
        rule: admitted.rule
      })
    }
    const id = await client.getNumberId(digits)
    await this.redis.client.set(
      key,
      id ?? NOT_REGISTERED,
      'EX',
      id === null ? NOT_REGISTERED_TTL_SECONDS : REGISTERED_TTL_SECONDS
    )
    return id
  }

  // The number is the caller's own input, and messages end up in logs: it is not repeated
  private notRegistered(): UnprocessableError {
    return new UnprocessableError(
      'NUMBER_NOT_ON_WHATSAPP',
      'The number is not registered on WhatsApp'
    )
  }
}
