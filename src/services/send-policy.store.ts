import { Inject, Injectable } from '@nestjs/common'

import { RedisService } from '../infra/redis/redis.service.js'

import { PolicyState } from './send-policy.state.js'

// How long Redis keeps the state of a session nobody touched. The rules look back 24 hours at most.
const STATE_TTL_SECONDS = 2 * 24 * 3600
// How long the unreachable flag of a chat lives when nothing clears it (TDD §6.8.1)
const UNREACHABLE_TTL_SECONDS = 30 * 24 * 3600
// Members of the per-session index read or deleted per Redis call
const INDEX_PAGE = 500

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
  // The chats flagged now, at most `limit`, the oldest flag first
  abstract listUnreachable(sessionId: string, limit: number): Promise<string[]>
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
// The chats flagged in one session, scored by when their flag lapses: listing and deleting read
// this set instead of walking the keyspace of the (shared) Redis
const indexKey = (sessionId: string): string => `policy:unreachable-index:${checked(sessionId)}`

// KEYS[1] flag, KEYS[2] index; ARGV[1] ttl seconds, ARGV[2] chat id. Flag and index entry change
// together. The score is when the flag lapses by the clock of Redis (its time plus the TTL the flag
// has left), so a flag that was already there keeps its real lapse time and the clock of this
// process does not matter. Answers 1 when the chat was not flagged before.
const FLAG_SCRIPT = `
local added = redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX')
local t = redis.call('TIME')
local lapsesAt = t[1] * 1000 + math.floor(t[2] / 1000) + redis.call('PTTL', KEYS[1])
redis.call('ZADD', KEYS[2], lapsesAt, ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
if added then return 1 end
return 0
`
// KEYS[1] flag, KEYS[2] index; ARGV[1] chat id. Answers 1 when the chat was flagged.
const CLEAR_SCRIPT = `
redis.call('ZREM', KEYS[2], ARGV[1])
return redis.call('DEL', KEYS[1])
`

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
    const added = await this.redis.client.eval(
      FLAG_SCRIPT,
      2,
      flagKey(sessionId, chatId),
      indexKey(sessionId),
      String(UNREACHABLE_TTL_SECONDS),
      chatId
    )
    return added === 1
  }

  async clearUnreachable(sessionId: string, chatId: string): Promise<boolean> {
    const removed = await this.redis.client.eval(
      CLEAR_SCRIPT,
      2,
      flagKey(sessionId, chatId),
      indexKey(sessionId),
      chatId
    )
    return typeof removed === 'number' && removed > 0
  }

  async listUnreachable(sessionId: string, limit: number): Promise<string[]> {
    // Redis reads a stop index of -1 as "to the end"
    if (limit <= 0) return []
    const index = indexKey(sessionId)
    // A flag that lapsed on its own leaves its entry until it is dropped here
    const [seconds = '0', micros = '0'] = await this.redis.client.time()
    const now = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)
    await this.redis.client.zremrangebyscore(index, '-inf', now)
    return this.redis.client.zrange(index, 0, String(limit - 1))
  }

  async delete(sessionId: string): Promise<void> {
    const index = indexKey(sessionId)
    await this.redis.client.del(stateKey(sessionId))
    for (;;) {
      const chats = await this.redis.client.zrange(index, 0, String(INDEX_PAGE - 1))
      if (chats.length === 0) break
      await this.redis.client.del(...chats.map(chatId => flagKey(sessionId, chatId)))
      await this.redis.client.zrem(index, ...chats)
    }
    // The set is gone with its last member; a flag set meanwhile keeps its entry
  }
}
