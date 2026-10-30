import { Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'

import { keyedDigest } from '../common/lib/crypto.js'
import { KeyedLock } from '../common/lib/keyed-lock.js'
import { withTimeout } from '../common/lib/timeout.js'
import { TokenBucket } from '../common/lib/token-bucket.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import {
  MessagesRepository,
  type OutgoingState
} from '../database/repositories/messages.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { SuppressionsRepository } from '../database/repositories/suppressions.repository.js'
import {
  type PolicyDecision,
  PolicyRule,
  type QuietHours,
  SendPolicySettings
} from '../types/send-policy.dto.js'

import {
  msUntilQuietEnds,
  normalizeContent,
  normalizeKeyword,
  scaleBudget,
  warmupFactor
} from './send-policy.rules.js'
import {
  emptyPolicyState,
  MAX_CHAT_ID_LENGTH,
  type PolicyState,
  STATE_LIST_LIMIT
} from './send-policy.state.js'
import { PolicyStateStore, UnreadablePolicyState } from './send-policy.store.js'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
// Wait before asking again when the state of the policy cannot be read or saved
const STATE_RETRY_MS = 5_000
// Redis commands of the gateway wait for the connection forever (BullMQ needs that), so every call
// to the store is bounded here or a Redis outage would hang the dispatch instead of delaying it
const STORE_TIMEOUT_MS = 2_000
// Postgres is read inside the per-session lock, so a query that hangs would stop every send of the
// session; past this deadline it fails and the dispatch delays
const DATABASE_TIMEOUT_MS = 5_000
// What `handleIncoming` needs even when the rest of the settings are unusable: an opt-out must be
// honored whatever else is wrong
const OptOutEnvelope = z.looseObject({
  sendPolicy: z.looseObject({ optOutKeywords: z.array(z.string()).optional() }).optional()
})

// The settings of a session are read again after this long; a change through the API is applied at
// once by `invalidateSettings`, and one made directly in the database within this time
const SETTINGS_TTL_MS = 30_000

export interface SendIntent {
  sessionId: string
  chatId: string
  // The text of the message, for the duplicate-content guard; left out for media without a caption
  body?: string | undefined
  // Milliseconds the policy has already held this job
  waitedMs: number
}

// The outcome of a send as the health throttle counts it: only hard failures (a send exception, a
// timeout, ack -1) are bad; an ack stuck at 1 is normal for an offline recipient
export type SendOutcome = 'ok' | 'hard_failure'

// A chat became unreachable or stopped being so: the moment `chat_unreachable` is published
export interface ReachabilityChange {
  sessionId: string
  chatId: string
  unreachable: boolean
}

// The limits of one session: the environment defaults with the session overrides on top
interface Limits {
  allowColdSends: boolean
  coldSendsPerDay: number
  coldSendMinGapMs: number
  lookupsPerDay: number
  perChatMinIntervalMs: number
  perChatMaxPerMinute: number
  sessionMaxPerMinute: number
  sessionMaxPerHour: number
  sessionMaxPerDay: number
  optOutKeywords: string[]
  quietHours: QuietHours | undefined
}

interface SessionSettings {
  limits: Limits
  linkedAt: Date | null
  readAt: number
}

// The keys of `Session.settings` this service reads; the others belong to other services
const SettingsEnvelope = z.looseObject({ sendPolicy: SendPolicySettings.optional() })

// The limits and scale of one session at one moment, before any message is looked at
interface Budgets {
  now: number
  limits: Limits
  // Scale of every count budget: the warm-up ramp, halved while the session is throttled
  factor: number
}

// Everything one evaluation needs, read once so the decision itself is synchronous
interface Context extends Budgets {
  suppressed: boolean
  cold: boolean
  unreachable: boolean
}

interface Delay {
  rule: PolicyRule
  ms: number
}

type ReachabilityListener = (change: ReachabilityChange) => void

const INVALID_CHAT_ID: PolicyDecision = {
  decision: 'reject',
  code: 'POLICY_BLOCKED',
  rule: PolicyRule.INVALID_CHAT_ID
}

function resolveLimits(config: AppConfig, settings: SendPolicySettings): Limits {
  return {
    allowColdSends: settings.allowColdSends ?? config.ALLOW_COLD_SENDS,
    coldSendsPerDay: settings.coldSendsPerDay ?? config.COLD_SENDS_PER_DAY,
    coldSendMinGapMs: settings.coldSendMinGapMs ?? config.COLD_SEND_MIN_GAP_MS,
    lookupsPerDay: settings.lookupsPerDay ?? config.LOOKUPS_PER_DAY,
    perChatMinIntervalMs: settings.perChatMinIntervalMs ?? config.PER_CHAT_MIN_INTERVAL_MS,
    perChatMaxPerMinute: settings.perChatMaxPerMinute ?? config.PER_CHAT_MAX_PER_MINUTE,
    sessionMaxPerMinute: settings.sessionMaxPerMinute ?? config.SESSION_MAX_PER_MINUTE,
    sessionMaxPerHour: settings.sessionMaxPerHour ?? config.SESSION_MAX_PER_HOUR,
    sessionMaxPerDay: settings.sessionMaxPerDay ?? config.SESSION_MAX_PER_DAY,
    optOutKeywords: (settings.optOutKeywords ?? []).map(normalizeKeyword),
    quietHours: settings.quietHours
  }
}

// Decides whether a message may go out, and when (TDD §6.8.1). `check` runs at enqueue and only
// rejects; `admit` runs right before dispatch and also paces.
//
// What the budgets have spent is a `PolicyState` per session. It is kept in memory and written to
// the `PolicyStateStore` before a decision that spends something is returned, so a restart does not
// hand the budgets out again. If the state cannot be read or saved the answer is a delay, never an
// allow: the policy fails closed. The operations that change a session's state run one at a time
// per session; the gateway runs a single instance, so that lock is enough. What is derived from
// Postgres (open conversation, unreachable recipient) and the suppression list are read on each
// call.
@Injectable()
export class SendPolicyService {
  private readonly logger = new Logger(SendPolicyService.name)
  private readonly lock = new KeyedLock()
  private readonly states = new Map<string, PolicyState>()
  private readonly settings = new Map<string, SessionSettings>()
  // Counts the deletions of a session, so a load that was in flight during one is thrown away
  private readonly epochs = new Map<string, number>()
  // Counts the changes announced for the settings of a session, so a read that was in flight when
  // one arrived is not kept
  private readonly settingsVersions = new Map<string, number>()
  private readonly listeners = new Set<ReachabilityListener>()
  private readonly digestSecret: string

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MessagesRepository) private readonly messages: MessagesRepository,
    @Inject(SuppressionsRepository) private readonly suppressions: SuppressionsRepository,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(PolicyStateStore) private readonly store: PolicyStateStore
  ) {
    this.digestSecret = config.ADMIN_API_KEY
  }

  // The cheap answer at enqueue: a rejection the caller can hear at once. It never delays and
  // never changes any budget. Without the state, or the settings, only the rules that need none are
  // applied; the dispatch asks again. A database failure is thrown, never turned into an allow.
  async check(intent: SendIntent): Promise<PolicyDecision> {
    if (intent.chatId.length > MAX_CHAT_ID_LENGTH) return INVALID_CHAT_ID
    const state = await this.tryState(intent.sessionId)
    const context = await this.contextOf(intent, state)
    if (!context) return { decision: 'allow' }
    return this.rejection(context, intent, state) ?? { decision: 'allow' }
  }

  // The answer right before dispatch. `allow` spends the budgets; `delay` spends nothing, so the
  // job asks again when it is its turn. A delay that would push the job past
  // SEND_POLICY_MAX_WAIT_MS ends it instead (quiet hours aside). Anything that goes wrong while
  // deciding, Postgres included, is a delay: the policy never allows what it could not check.
  admit(intent: SendIntent): Promise<PolicyDecision> {
    return this.lock.run(intent.sessionId, async () => {
      try {
        return await this.decide(intent)
      } catch (error) {
        this.logger.error(`[${intent.sessionId}] The send policy failed (${kindOf(error)})`)
        return this.unavailable(intent)
      }
    })
  }

  private async decide(intent: SendIntent): Promise<PolicyDecision> {
    if (intent.chatId.length > MAX_CHAT_ID_LENGTH) return INVALID_CHAT_ID
    const state = await this.tryState(intent.sessionId)
    const context = await this.contextOf(intent, state)
    if (!context) return this.unavailable(intent, PolicyRule.SETTINGS_UNAVAILABLE)
    const rejected = this.rejection(context, intent, state)
    if (rejected) return rejected
    if (!state) return this.unavailable(intent)

    const delays = this.delaysOf(context, intent, state)
    if (delays.length > 0) return this.waiting(intent, delays)

    const saved = await this.commit(intent.sessionId, this.spend(context, intent, state))
    return saved ? { decision: 'allow' } : this.unavailable(intent)
  }

  // Counts a `getNumberId` lookup made for a cold send against LOOKUPS_PER_DAY: many look-ups of
  // numbers that are not on WhatsApp is itself a signal
  admitLookup(sessionId: string): Promise<PolicyDecision> {
    return this.lock.run(sessionId, async () => {
      const intent = { sessionId, chatId: '', waitedMs: 0 }
      const state = await this.tryState(sessionId)
      const budgets = await this.budgetsOf(sessionId, state)
      if (!budgets) return this.unavailable(intent, PolicyRule.SETTINGS_UNAVAILABLE)
      if (!state) return this.unavailable(intent)

      const recent = state.lookups.filter(at => at > budgets.now - MS_PER_DAY)
      if (recent.length >= scaleBudget(budgets.limits.lookupsPerDay, budgets.factor)) {
        return { decision: 'reject', code: 'POLICY_BLOCKED', rule: PolicyRule.LOOKUPS_PER_DAY }
      }
      const lookups = [...recent, budgets.now].slice(-STATE_LIST_LIMIT)
      const saved = await this.commit(sessionId, { ...state, lookups })
      return saved ? { decision: 'allow' } : this.unavailable(intent)
    })
  }

  // Feeds the health throttle. True once, when this result makes the bad ratio of the window pass
  // HEALTH_MAX_BAD_RATIO with at least HEALTH_MIN_SAMPLES results: the caller publishes
  // `session_error` (SEND_HEALTH_DEGRADED). The budgets are halved until the cooldown ends and the
  // window starts empty afterwards. A result that cannot be saved is kept in memory.
  recordOutcome(sessionId: string, outcome: SendOutcome): Promise<boolean> {
    return this.lock.run(sessionId, async () => {
      const state = await this.tryState(sessionId)
      if (!state) return false
      const now = Date.now()
      const next = structuredClone(state)
      if (next.degradedUntil !== 0 && next.degradedUntil <= now) {
        next.degradedUntil = 0
        next.results = []
      }
      next.results.push(outcome === 'hard_failure')
      next.results = next.results.slice(-this.config.HEALTH_WINDOW)

      const needed = Math.min(this.config.HEALTH_WINDOW, this.config.HEALTH_MIN_SAMPLES)
      const bad = next.results.filter(Boolean).length
      const tripped =
        next.degradedUntil === 0 &&
        next.results.length >= needed &&
        bad / next.results.length > this.config.HEALTH_MAX_BAD_RATIO
      if (tripped) {
        next.degradedUntil = now + this.config.HEALTH_COOLDOWN_MIN * MS_PER_MINUTE
        next.results = []
        this.logger.warn(`[${sessionId}] Send health degraded: budgets halved`)
      }
      if (!(await this.commit(sessionId, next))) this.states.set(sessionId, next)
      return tripped
    })
  }

  // An incoming message proves the contact can reach us, so a chat flagged as unreachable is
  // cleared. If its whole text is an opt-out keyword of the session the chat also goes on the
  // suppression list: true only the first time, which is when `chat_suppressed` is published.
  async handleIncoming(sessionId: string, chatId: string, text: string): Promise<boolean> {
    await this.unflag(sessionId, chatId)
    const keywords = await this.optOutKeywordsOf(sessionId)
    if (!keywords.includes(normalizeKeyword(text))) return false
    const { created } = await this.suppressions.add({ sessionId, chatId, reason: 'opt_out' })
    return created
  }

  // Listens to chats becoming unreachable or reachable again
  onReachabilityChange(listener: ReachabilityListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // The settings of the session changed: read them again on the next call. The last valid ones
  // stay as the fallback if the new ones turn out to be unusable.
  invalidateSettings(sessionId: string): void {
    this.settingsVersions.set(sessionId, (this.settingsVersions.get(sessionId) ?? 0) + 1)
    const known = this.settings.get(sessionId)
    if (known) this.settings.set(sessionId, { ...known, readAt: 0 })
  }

  // The session was deleted: its budgets and flags go with it. The callers stop its sends first;
  // a call that arrives later would start a new state for an id that no longer exists.
  forget(sessionId: string): Promise<void> {
    return this.lock.run(sessionId, async () => {
      this.drop(sessionId)
      try {
        await this.io(this.store.delete(sessionId), 'policy state delete')
      } finally {
        // A read that started while the delete was running may have cached what is being deleted
        this.drop(sessionId)
      }
    })
  }

  private drop(sessionId: string): void {
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
    this.states.delete(sessionId)
    this.settings.delete(sessionId)
  }

  // The limits of the session. A row that is missing or whose settings are invalid never loosens
  // anything: the last valid settings stay in force, and with none the answer is undefined, which
  // the callers turn into a delay.
  private async settingsOf(sessionId: string, now: number): Promise<SessionSettings | undefined> {
    const known = this.settings.get(sessionId)
    if (known && now - known.readAt < SETTINGS_TTL_MS) return known
    const version = this.settingsVersions.get(sessionId) ?? 0
    const session = await this.db(this.sessions.findById(sessionId), 'session read')
    // A change was announced while the row was being read: what was read may be the old one
    if ((this.settingsVersions.get(sessionId) ?? 0) !== version) {
      return this.settingsOf(sessionId, Date.now())
    }
    const parsed = session ? SettingsEnvelope.safeParse(session.settings) : undefined
    if (!session || !parsed?.success) {
      const where = parsed && !parsed.success ? ` (${paths(parsed.error)})` : ' (no such session)'
      this.logger.warn(`[${sessionId}] Unusable sendPolicy settings${where}`)
      if (!known) return undefined
      const kept = { ...known, readAt: now }
      this.settings.set(sessionId, kept)
      return kept
    }
    const read: SessionSettings = {
      limits: resolveLimits(this.config, parsed.data.sendPolicy ?? {}),
      linkedAt: session.linkedAt,
      readAt: now
    }
    this.settings.set(sessionId, read)
    return read
  }

  // The opt-out keywords of the session. When the settings as a whole are unusable the keywords
  // are still read on their own; if they cannot be read either the error is thrown, so the
  // pipeline can try again instead of ignoring a contact who asked to stop.
  private async optOutKeywordsOf(sessionId: string): Promise<string[]> {
    const budgets = await this.budgetsOf(sessionId, undefined)
    if (budgets) return budgets.limits.optOutKeywords
    const session = await this.db(this.sessions.findById(sessionId), 'session read')
    if (!session) return []
    const parsed = OptOutEnvelope.safeParse(session.settings)
    if (!parsed.success) {
      this.logger.error(`[${sessionId}] The opt-out keywords cannot be read from the settings`)
      throw new Error('The opt-out keywords cannot be read')
    }
    return (parsed.data.sendPolicy?.optOutKeywords ?? []).map(normalizeKeyword)
  }

  // `state` is the one read before the decision, or a restart in the middle of a throttle would
  // forget it; it is left out where the scale does not matter
  private async budgetsOf(
    sessionId: string,
    state: PolicyState | undefined
  ): Promise<Budgets | undefined> {
    const now = Date.now()
    const settings = await this.settingsOf(sessionId, now)
    if (!settings) return undefined
    const degraded = (state?.degradedUntil ?? 0) > now
    const ramp = warmupFactor(
      settings.linkedAt,
      now,
      this.config.WARMUP_DAYS,
      this.config.WARMUP_START_FRACTION
    )
    return { now, limits: settings.limits, factor: (degraded ? 0.5 : 1) * ramp }
  }

  private async contextOf(
    intent: SendIntent,
    state: PolicyState | undefined
  ): Promise<Context | undefined> {
    const budgets = await this.budgetsOf(intent.sessionId, state)
    if (!budgets) return undefined
    const { now } = budgets
    const [suppressed, lastIncomingAt] = await Promise.all([
      this.db(this.suppressions.isSuppressed(intent.sessionId, intent.chatId), 'suppression read'),
      this.db(this.messages.lastIncomingAt(intent.sessionId, intent.chatId), 'last incoming read')
    ])
    // The arrival time is ours, but a clock that was set back must not make a message "from the future"
    const lastIncomingMs = lastIncomingAt ? Math.min(lastIncomingAt.getTime(), now) : undefined
    const windowMs = this.config.CONVERSATION_WINDOW_HOURS * MS_PER_HOUR
    const cold = lastIncomingMs === undefined || now - lastIncomingMs > windowMs
    const unreachable = cold && (await this.isUnreachable(intent, lastIncomingMs, now))
    if (cold) await this.syncFlag(intent, unreachable)
    return { ...budgets, suppressed, cold, unreachable }
  }

  // Silent for UNREACHABLE_MIN_AGE_HOURS, and the last UNREACHABLE_STREAK messages we sent are all
  // still below ack 2, the oldest of them as old as that age. Derived every time from the stored
  // messages, so it clears by itself when the contact writes or a message is delivered.
  private async isUnreachable(
    intent: SendIntent,
    lastIncomingMs: number | undefined,
    now: number
  ): Promise<boolean> {
    const minAgeMs = this.config.UNREACHABLE_MIN_AGE_HOURS * MS_PER_HOUR
    if (lastIncomingMs !== undefined && now - lastIncomingMs < minAgeMs) return false
    const recent: OutgoingState[] = await this.db(
      this.messages.listRecentOutgoing(
        intent.sessionId,
        intent.chatId,
        this.config.UNREACHABLE_STREAK
      ),
      'recent outgoing read'
    )
    if (recent.length < this.config.UNREACHABLE_STREAK) return false
    // An unknown ack is no proof that the message was not delivered
    if (recent.some(message => message.ack === null || message.ack >= 2)) return false
    const oldest = recent[recent.length - 1]
    return oldest !== undefined && now - oldest.sentAt.getTime() >= minAgeMs
  }

  // Keeps the flag of the store in step with what the messages say, only to tell the moment it
  // changes. A store that fails does not change the decision, which comes from the messages.
  private async syncFlag(intent: SendIntent, unreachable: boolean): Promise<void> {
    try {
      const changed = unreachable
        ? await this.io(this.store.flagUnreachable(intent.sessionId, intent.chatId), 'flag')
        : await this.io(this.store.clearUnreachable(intent.sessionId, intent.chatId), 'unflag')
      if (changed) this.notify({ sessionId: intent.sessionId, chatId: intent.chatId, unreachable })
    } catch {
      this.logger.warn(`[${intent.sessionId}] The unreachable flag of a chat could not be updated`)
    }
  }

  private async unflag(sessionId: string, chatId: string): Promise<void> {
    try {
      if (await this.io(this.store.clearUnreachable(sessionId, chatId), 'unflag')) {
        this.notify({ sessionId, chatId, unreachable: false })
      }
    } catch {
      this.logger.warn(`[${sessionId}] The unreachable flag of a chat could not be cleared`)
    }
  }

  private notify(change: ReachabilityChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        this.logger.warn(`[${change.sessionId}] A reachability listener failed`)
      }
    }
  }

  // The state of the session, from memory or else from the store. Undefined when the store cannot
  // be read: the callers then fail closed. A saved state that is unreadable is replaced by one that
  // starts the session throttled for the cooldown, never by full budgets.
  private async tryState(sessionId: string): Promise<PolicyState | undefined> {
    const known = this.states.get(sessionId)
    if (known) return known
    const epoch = this.epochs.get(sessionId) ?? 0
    let loaded: PolicyState
    try {
      loaded =
        (await this.io(this.store.load(sessionId), 'policy state load')) ?? emptyPolicyState()
    } catch (error) {
      if (!(error instanceof UnreadablePolicyState)) {
        this.logger.warn(`[${sessionId}] The send policy state could not be read`)
        return undefined
      }
      this.logger.error(
        `[${sessionId}] The saved send policy state (policy:state:${sessionId}) is unreadable: throttling`
      )
      loaded = {
        ...emptyPolicyState(),
        degradedUntil: Date.now() + this.config.HEALTH_COOLDOWN_MIN * MS_PER_MINUTE
      }
    }
    // This runs outside the lock for `check`, so the answer may be late: a state saved meanwhile is
    // newer than what was read, and a session deleted meanwhile must not come back
    const raced = this.states.get(sessionId)
    if (raced) return raced
    if ((this.epochs.get(sessionId) ?? 0) !== epoch) return this.tryState(sessionId)
    this.states.set(sessionId, loaded)
    return loaded
  }

  // Saves first and keeps in memory only what was saved: a decision that spent a budget is never
  // returned unless the spending survives a restart. False when the store failed; the copy in
  // memory is dropped then, because a save that timed out may still have reached Redis, and the
  // next call reads what is really there.
  private async commit(sessionId: string, next: PolicyState): Promise<boolean> {
    try {
      await this.io(this.store.save(sessionId, next), 'policy state save')
    } catch {
      this.logger.warn(`[${sessionId}] The send policy state could not be saved`)
      this.states.delete(sessionId)
      return false
    }
    this.states.set(sessionId, next)
    return true
  }

  private io<T>(operation: Promise<T>, label: string): Promise<T> {
    return withTimeout(operation, STORE_TIMEOUT_MS, label)
  }

  private db<T>(operation: Promise<T>, label: string): Promise<T> {
    return withTimeout(operation, DATABASE_TIMEOUT_MS, label)
  }

  private unavailable(
    intent: SendIntent,
    rule: PolicyRule = PolicyRule.STATE_UNAVAILABLE
  ): PolicyDecision {
    return this.waiting(intent, [{ rule, ms: STATE_RETRY_MS }])
  }

  // The longest of the delays, or the end of the job when one of them would pass
  // SEND_POLICY_MAX_WAIT_MS. Quiet hours are the exception: waiting for the end of the window is
  // what the rule asks for, and it is never longer than a day. They do not excuse another delay.
  private waiting(intent: SendIntent, delays: Delay[]): PolicyDecision {
    const left = Math.max(0, this.config.SEND_POLICY_MAX_WAIT_MS - intent.waitedMs)
    if (delays.some(delay => delay.rule !== PolicyRule.QUIET_HOURS && delay.ms > left)) {
      return { decision: 'reject', code: 'POLICY_DELAY_EXCEEDED', rule: PolicyRule.DELAY_EXCEEDED }
    }
    const longest = delays.reduce((a, b) => (b.ms > a.ms ? b : a))
    return { decision: 'delay', delayMs: longest.ms, rule: longest.rule }
  }

  private rejection(
    context: Context,
    intent: SendIntent,
    state: PolicyState | undefined
  ): PolicyDecision | undefined {
    const { limits, cold } = context
    if (context.suppressed) {
      return { decision: 'reject', code: 'RECIPIENT_SUPPRESSED', rule: PolicyRule.SUPPRESSED }
    }
    if (!cold) return undefined
    if (!limits.allowColdSends) {
      return { decision: 'reject', code: 'POLICY_BLOCKED', rule: PolicyRule.COLD_SENDS_DISABLED }
    }
    if (context.unreachable) {
      return { decision: 'reject', code: 'RECIPIENT_UNREACHABLE', rule: PolicyRule.UNREACHABLE }
    }
    if (state && this.isDuplicate(state, intent, context.now)) {
      return { decision: 'reject', code: 'DUPLICATE_CONTENT', rule: PolicyRule.DUPLICATE_CONTENT }
    }
    if (state && this.coldBudgetSpent(state, intent.chatId, context)) {
      return { decision: 'reject', code: 'POLICY_BLOCKED', rule: PolicyRule.COLD_SENDS_PER_DAY }
    }
    return undefined
  }

  // The same text already went to DUPLICATE_RECIPIENTS_THRESHOLD other chats in the window
  private isDuplicate(state: PolicyState, intent: SendIntent, now: number): boolean {
    if (!intent.body) return false
    const hash = this.digestOf(intent.body)
    const since = now - this.config.DUPLICATE_WINDOW_MINUTES * MS_PER_MINUTE
    const chats = new Set<string>()
    for (const sent of state.sent) {
      if (sent.at >= since && sent.hash === hash && sent.chatId !== intent.chatId) {
        chats.add(sent.chatId)
      }
    }
    return chats.size >= this.config.DUPLICATE_RECIPIENTS_THRESHOLD
  }

  // A new chat would be the one past the daily budget; a chat already contacted today is not new
  private coldBudgetSpent(state: PolicyState, chatId: string, context: Context): boolean {
    const today = state.coldChats.filter(cold => cold.at > context.now - MS_PER_DAY)
    if (today.some(cold => cold.chatId === chatId)) return false
    return today.length >= scaleBudget(context.limits.coldSendsPerDay, context.factor)
  }

  private bucket(
    max: number,
    windowMs: number,
    context: Context,
    saved?: { tokens: number; at: number }
  ): TokenBucket {
    return new TokenBucket(
      { capacity: scaleBudget(max, context.factor), windowMs, now: () => context.now },
      saved
    )
  }

  // Every wait that applies to this message right now
  private delaysOf(context: Context, intent: SendIntent, state: PolicyState): Delay[] {
    const { limits, cold, now } = context
    const chat = state.chats.find(entry => entry.chatId === intent.chatId)
    const delays: Delay[] = [
      {
        rule: PolicyRule.SESSION_PER_MINUTE,
        ms: this.bucket(
          limits.sessionMaxPerMinute,
          MS_PER_MINUTE,
          context,
          state.perMinute
        ).delayMs()
      },
      {
        rule: PolicyRule.SESSION_PER_HOUR,
        ms: this.bucket(limits.sessionMaxPerHour, MS_PER_HOUR, context, state.perHour).delayMs()
      },
      {
        rule: PolicyRule.SESSION_PER_DAY,
        ms: this.bucket(limits.sessionMaxPerDay, MS_PER_DAY, context, state.perDay).delayMs()
      },
      {
        rule: PolicyRule.PER_CHAT_INTERVAL,
        ms: chat ? Math.min(chat.lastAt, now) + limits.perChatMinIntervalMs - now : 0
      },
      {
        rule: PolicyRule.PER_CHAT_PER_MINUTE,
        ms: chat
          ? this.bucket(
              limits.perChatMaxPerMinute,
              MS_PER_MINUTE,
              context,
              chat.perMinute
            ).delayMs()
          : 0
      }
    ]
    if (cold) {
      delays.push({ rule: PolicyRule.QUIET_HOURS, ms: msUntilQuietEnds(limits.quietHours, now) })
      if (!state.coldChats.some(entry => entry.chatId === intent.chatId)) {
        delays.push({
          rule: PolicyRule.COLD_SEND_GAP,
          ms: Math.min(state.lastColdAt, now) + limits.coldSendMinGapMs - now
        })
      }
    }
    return delays.filter(delay => delay.ms > 0)
  }

  // What the duplicate guard compares: a keyed digest, so the policy keeps no text of a message and
  // a short template cannot be recovered by hashing guesses
  private digestOf(body: string): string {
    return keyedDigest(this.digestSecret, 'send-policy-content', normalizeContent(body))
  }

  // The state after this message went out: every budget spent, and what no rule can look at any
  // more forgotten, so the saved state stays small
  private spend(context: Context, intent: SendIntent, state: PolicyState): PolicyState {
    const { now, cold, limits } = context
    const next = structuredClone(state)

    const minute = this.bucket(limits.sessionMaxPerMinute, MS_PER_MINUTE, context, next.perMinute)
    const hour = this.bucket(limits.sessionMaxPerHour, MS_PER_HOUR, context, next.perHour)
    const day = this.bucket(limits.sessionMaxPerDay, MS_PER_DAY, context, next.perDay)
    minute.consume()
    hour.consume()
    day.consume()
    next.perMinute = minute.snapshot()
    next.perHour = hour.snapshot()
    next.perDay = day.snapshot()

    const known = next.chats.find(entry => entry.chatId === intent.chatId)
    const perChat = this.bucket(
      limits.perChatMaxPerMinute,
      MS_PER_MINUTE,
      context,
      known?.perMinute
    )
    perChat.consume()
    const entry = { chatId: intent.chatId, lastAt: now, perMinute: perChat.snapshot() }
    next.chats = [...next.chats.filter(other => other.chatId !== intent.chatId), entry]

    if (cold && !next.coldChats.some(other => other.chatId === intent.chatId)) {
      next.coldChats.push({ chatId: intent.chatId, at: now })
      next.lastColdAt = now
    }
    if (intent.body) {
      next.sent.push({ hash: this.digestOf(intent.body), chatId: intent.chatId, at: now })
    }

    const chatsSince = now - Math.max(MS_PER_MINUTE, limits.perChatMinIntervalMs)
    const sentSince = now - this.config.DUPLICATE_WINDOW_MINUTES * MS_PER_MINUTE
    next.chats = next.chats.filter(other => other.lastAt > chatsSince)
    next.coldChats = next.coldChats.filter(other => other.at > now - MS_PER_DAY)
    next.lookups = next.lookups.filter(at => at > now - MS_PER_DAY)
    next.sent = next.sent.filter(sent => sent.at >= sentSince).slice(-STATE_LIST_LIMIT)
    next.chats = next.chats.slice(-STATE_LIST_LIMIT)
    next.coldChats = next.coldChats.slice(-STATE_LIST_LIMIT)
    next.lookups = next.lookups.slice(-STATE_LIST_LIMIT)
    return next
  }
}

function kindOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

// Which settings were wrong, never their values
function paths(error: z.ZodError): string {
  return [...new Set(error.issues.map(issue => issue.path.join('.') || '(root)'))].join(', ')
}
