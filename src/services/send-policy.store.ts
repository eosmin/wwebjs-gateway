import { Inject, Injectable } from '@nestjs/common'

import { RedisService } from '../infra/redis/redis.service.js'

import { PolicyState } from './send-policy.state.js'

// How long Redis keeps the state of a session nobody touched. The rules look back 24 hours at most.
const STATE_TTL_SECONDS = 2 * 24 * 3600
// How long the unreachable flag of a chat lives when nothing clears it (TDD §6.8.1)
const UNREACHABLE_TTL_SECONDS = 30 * 24 * 3600
const SCAN_COUNT = 200

// The saved state exists but cannot be used: not JSON, or not the shape of a state. The service
// does not start from full budgets in that case.
export class UnreadablePolicyState extends Error {
  constructor(sessionId: string) {
    super(`The saved send policy state of session ${sessionId} is unreadable`)
    this.name = 'UnreadablePolicyState'
  }
}

// Where the send policy keeps what it spent, so a restart does not hand out the budgets again. An
// abstract class so Nest can inject it and the unit tests can bring their own.
export abstract class PolicyStateStore {
  // Null when the session has no saved state; throws UnreadablePolicyState when it has one that cannot be read back
  abstract load(sessionId: string): Promise<PolicyState | null>
  abstract save(sessionId: string, state: PolicyState): Promise<void>
  // True when the chat was not flagged before: the moment `chat_unreachable` is published
  abstract flagUnreachable(sessionId: string, chatId: string): Promise<boolean>
  // True when the chat was flagged
  abstract clearUnreachable(sessionId: string, chatId: string): Promise<boolean>
  // The session was deleted
  abstract delete(sessionId: string): Promise<void>
}

// The same shape the API enforces for a session id. Checked here too because the id goes into a
// key and into a SCAN pattern, where `*`, `?`, `[` and `:` mean something.
const SESSION_ID = /^[-_\w]{1,64}$/

function checked(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new RangeError('Not a valid session id')
  return sessionId
}

const stateKey = (sessionId: string): string => `policy:state:${checked(sessionId)}`
const flagKey = (sessionId: string, chatId: string): string =>
  `policy:unreachable:${checked(sessionId)}:${chatId}`

@Injectable()
export class RedisPolicyStateStore extends PolicyStateStore {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    super()
  }

  async load(sessionId: string): Promise<PolicyState | null> {
    const raw = await this.redis.client.get(stateKey(sessionId))
    if (raw === null) return null
    try {
      return PolicyState.parse(JSON.parse(raw))
    } catch {
      throw new UnreadablePolicyState(sessionId)
    }
  }

  async save(sessionId: string, state: PolicyState): Promise<void> {
    await this.redis.client.set(stateKey(sessionId), JSON.stringify(state), 'EX', STATE_TTL_SECONDS)
  }

  async flagUnreachable(sessionId: string, chatId: string): Promise<boolean> {
    const result = await this.redis.client.set(
      flagKey(sessionId, chatId),
      '1',
      'EX',
      UNREACHABLE_TTL_SECONDS,
      'NX'
    )
    return result === 'OK'
  }

  async clearUnreachable(sessionId: string, chatId: string): Promise<boolean> {
    return (await this.redis.client.del(flagKey(sessionId, chatId))) > 0
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.client.del(stateKey(sessionId))
    const stream = this.redis.client.scanStream({
      match: `policy:unreachable:${checked(sessionId)}:*`,
      count: SCAN_COUNT
    })
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length > 0) await this.redis.client.del(...keys)
    }
  }
}
