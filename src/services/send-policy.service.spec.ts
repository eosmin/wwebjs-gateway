import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { FakePolicyStateStore } from '../../tests/helpers/fake-policy-state-store.js'
import { parseEnv } from '../config/env.schema.js'
import type {
  OutgoingState,
  MessagesRepository
} from '../database/repositories/messages.repository.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { SuppressionsRepository } from '../database/repositories/suppressions.repository.js'
import { type PolicyDecision, SendPolicySettings } from '../types/send-policy.dto.js'

import { SendPolicyService, type SendIntent } from './send-policy.service.js'

// 23:00 UTC, inside a 22:00-07:00 quiet window
const NOW = new Date('2026-10-29T23:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

jest.useFakeTimers({ now: NOW })

interface World {
  settings: Record<string, unknown>
  linkedAt: Date | null
  // When the contact last wrote, per chat; `incomingDefault` answers for the others
  incoming: Map<string, Date | null>
  incomingDefault: Date | null
  outgoing: OutgoingState[]
  suppressed: Set<string>
  suppressionAdds: { chatId: string; reason: string }[]
  // The session row does not exist
  missing: boolean
  // The next reads of the database fail
  databaseDown: boolean
  // The next reads of the database never answer
  databaseHangs: boolean
  heldSessionReads: Promise<void>[]
}

function setup(env: Record<string, string> = {}) {
  const world: World = {
    settings: {},
    linkedAt: new Date(NOW.getTime() - 100 * DAY),
    incoming: new Map(),
    incomingDefault: new Date(NOW.getTime() - HOUR),
    outgoing: [],
    suppressed: new Set(),
    suppressionAdds: [],
    missing: false,
    databaseDown: false,
    databaseHangs: false,
    heldSessionReads: []
  }
  const messages = {
    lastIncomingAt: jest.fn((_s: string, chatId: string) =>
      Promise.resolve(
        world.incoming.has(chatId) ? world.incoming.get(chatId) : world.incomingDefault
      )
    ),
    listRecentOutgoing: jest.fn((_s: string, _c: string, limit: number) =>
      Promise.resolve(world.outgoing.slice(0, limit))
    )
  }
  const suppressions = {
    isSuppressed: jest.fn((_s: string, chatId: string) =>
      Promise.resolve(world.suppressed.has(chatId))
    ),
    add: jest.fn((data: { chatId: string; reason: string }) => {
      const created = !world.suppressed.has(data.chatId)
      world.suppressed.add(data.chatId)
      world.suppressionAdds.push({ chatId: data.chatId, reason: data.reason })
      return Promise.resolve({ created, suppression: data })
    })
  }
  const sessions = {
    findById: jest.fn(async () => {
      if (world.databaseHangs) return new Promise<never>(() => undefined)
      if (world.databaseDown) throw new Error('database down')
      // The row is read now and handed over later: a slow database
      const row = world.missing ? null : { settings: world.settings, linkedAt: world.linkedAt }
      await world.heldSessionReads.shift()
      return row
    })
  }
  const store = new FakePolicyStateStore()
  const config = parseEnv({ ...TEST_ENV, ...env })
  const build = (): SendPolicyService =>
    new SendPolicyService(
      config,
      messages as unknown as MessagesRepository,
      suppressions as unknown as SuppressionsRepository,
      sessions as unknown as SessionsRepository,
      store
    )
  return { policy: build(), build, world, suppressions, sessions, store }
}

const intent = (over: Partial<SendIntent> = {}): SendIntent => ({
  sessionId: 's1',
  chatId: 'a@c.us',
  body: 'hola',
  waitedMs: 0,
  ...over
})

const ALLOW: PolicyDecision = { decision: 'allow' }
const reject = (code: string, rule: string): PolicyDecision =>
  ({ decision: 'reject', code, rule }) as PolicyDecision
const delay = (delayMs: number, rule: string): PolicyDecision =>
  ({ decision: 'delay', delayMs, rule }) as PolicyDecision

// Sends to a different open chat every time until the policy asks for a delay
async function sendUntilDelayed(
  policy: SendPolicyService,
  limit = 100
): Promise<{ allowed: number; stopped: PolicyDecision }> {
  let allowed = 0
  for (let i = 0; i < limit; i++) {
    const decision = await policy.admit(intent({ chatId: `chat${i}@c.us`, body: undefined }))
    if (decision.decision !== 'allow') return { allowed, stopped: decision }
    allowed++
  }
  return { allowed, stopped: ALLOW }
}

// Spreads the sends of a test over a session whose per-chat limits do not get in the way
// Lets a test see a wait longer than the 30 minutes the policy allows by default
const LONG_WAIT = { SEND_POLICY_MAX_WAIT_MS: String(DAY) }

const WIDE_CHAT = { PER_CHAT_MIN_INTERVAL_MS: '0', PER_CHAT_MAX_PER_MINUTE: '60' }

describe('SendPolicyService', () => {
  beforeEach(() => {
    jest.setSystemTime(NOW)
  })

  describe('open conversation and cold sends (rules 1 and 2)', () => {
    it('lets a reply inside an open conversation through', async () => {
      const { policy } = setup()

      expect(await policy.check(intent())).toEqual(ALLOW)
      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('blocks a send to a chat that never wrote, because cold sends are off by default', async () => {
      const { policy, world } = setup()
      world.incomingDefault = null

      const expected = reject('POLICY_BLOCKED', 'cold_sends_disabled')
      expect(await policy.check(intent())).toEqual(expected)
      expect(await policy.admit(intent())).toEqual(expected)
    })

    it('treats a chat as cold once its last incoming message is older than the window', async () => {
      const { policy, world } = setup()
      world.incomingDefault = new Date(NOW.getTime() - 25 * HOUR)
      expect(await policy.check(intent())).toEqual(reject('POLICY_BLOCKED', 'cold_sends_disabled'))

      world.incomingDefault = new Date(NOW.getTime() - 23 * HOUR)
      expect(await policy.check(intent())).toEqual(ALLOW)
    })

    it('follows CONVERSATION_WINDOW_HOURS', async () => {
      const { policy, world } = setup({ CONVERSATION_WINDOW_HOURS: '2' })
      world.incomingDefault = new Date(NOW.getTime() - 3 * HOUR)

      expect(await policy.check(intent())).toEqual(reject('POLICY_BLOCKED', 'cold_sends_disabled'))
    })

    it('allows cold sends when the environment turns them on', async () => {
      const { policy, world } = setup({ ALLOW_COLD_SENDS: 'true' })
      world.incomingDefault = null

      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('lets the session setting override the environment in both directions', async () => {
      const on = setup()
      on.world.incomingDefault = null
      on.world.settings = { sendPolicy: { allowColdSends: true } }
      expect(await on.policy.admit(intent())).toEqual(ALLOW)

      const off = setup({ ALLOW_COLD_SENDS: 'true' })
      off.world.incomingDefault = null
      off.world.settings = { sendPolicy: { allowColdSends: false } }
      expect(await off.policy.admit(intent())).toEqual(
        reject('POLICY_BLOCKED', 'cold_sends_disabled')
      )
    })

    it('delays, and does not fall back to the defaults, when the settings are invalid from the start', async () => {
      const { policy, world } = setup({ ALLOW_COLD_SENDS: 'true' })
      world.incomingDefault = null
      world.settings = { sendPolicy: { allowColdSends: 'yes', nonsense: 1 } }

      expect(await policy.admit(intent())).toEqual(delay(5000, 'settings_unavailable'))
    })

    it('keeps the last valid settings when they become invalid, so limits never loosen', async () => {
      const { policy, world } = setup({ ALLOW_COLD_SENDS: 'true' })
      world.incomingDefault = null
      world.settings = { sendPolicy: { allowColdSends: false } }
      expect((await policy.admit(intent())).decision).toBe('reject')

      world.settings = { sendPolicy: { allowColdSends: 'yes' } }
      jest.setSystemTime(NOW.getTime() + 31_000)

      expect(await policy.admit(intent())).toEqual(reject('POLICY_BLOCKED', 'cold_sends_disabled'))
    })

    it('does not name the wrong values in the log, only the keys', async () => {
      const { policy, world } = setup()
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      world.settings = { sendPolicy: { optOutKeywords: 'secret-value', sessionMaxPerDay: 1e9 } }

      await policy.check(intent())

      const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
      expect(logged).toContain('sendPolicy.optOutKeywords')
      expect(logged).not.toContain('secret-value')
      warn.mockRestore()
    })

    it('delays for a session whose row does not exist', async () => {
      const { policy, world } = setup()
      world.missing = true

      expect(await policy.admit(intent())).toEqual(delay(5000, 'settings_unavailable'))
      expect(await policy.admitLookup('s1')).toEqual(delay(5000, 'settings_unavailable'))
      expect(await policy.check(intent())).toEqual(ALLOW)
      expect(await policy.handleIncoming('s1', 'a@c.us', 'stop')).toBe(false)
    })

    it('refuses a limit set to a billion, so a setting cannot switch a rule off', () => {
      expect(SendPolicySettings.safeParse({ sessionMaxPerDay: 1_000_000_000 }).success).toBe(false)
      expect(SendPolicySettings.safeParse({ coldSendsPerDay: 1001 }).success).toBe(false)
      expect(SendPolicySettings.safeParse({ perChatMaxPerMinute: 61 }).success).toBe(false)
      expect(SendPolicySettings.safeParse({ sessionMaxPerDay: 100_000 }).success).toBe(true)
    })
  })

  describe('cold send budget (rule 2)', () => {
    const cold = { ALLOW_COLD_SENDS: 'true', ...WIDE_CHAT }

    it('rejects a new chat past COLD_SENDS_PER_DAY, but not a chat already contacted', async () => {
      const { policy, world } = setup({
        ...cold,
        COLD_SENDS_PER_DAY: '2',
        COLD_SEND_MIN_GAP_MS: '0'
      })
      world.incomingDefault = null

      expect(await policy.admit(intent({ chatId: 'one@c.us' }))).toEqual(ALLOW)
      expect(await policy.admit(intent({ chatId: 'two@c.us' }))).toEqual(ALLOW)

      const blocked = reject('POLICY_BLOCKED', 'cold_sends_per_day')
      expect(await policy.admit(intent({ chatId: 'three@c.us' }))).toEqual(blocked)
      expect(await policy.check(intent({ chatId: 'three@c.us' }))).toEqual(blocked)
      expect(await policy.admit(intent({ chatId: 'one@c.us' }))).toEqual(ALLOW)
    })

    it('gives the budget back after a day', async () => {
      const { policy, world } = setup({
        ...cold,
        COLD_SENDS_PER_DAY: '1',
        COLD_SEND_MIN_GAP_MS: '0'
      })
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'one@c.us' }))
      expect((await policy.admit(intent({ chatId: 'two@c.us' }))).decision).toBe('reject')

      jest.setSystemTime(NOW.getTime() + DAY + 1)

      expect(await policy.admit(intent({ chatId: 'two@c.us' }))).toEqual(ALLOW)
    })

    it('spaces two cold sends by COLD_SEND_MIN_GAP_MS with a delay, not an error', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'one@c.us' }))

      expect(await policy.admit(intent({ chatId: 'two@c.us' }))).toEqual(
        delay(60_000, 'cold_send_gap')
      )

      jest.setSystemTime(NOW.getTime() + 60_000)
      expect(await policy.admit(intent({ chatId: 'two@c.us' }))).toEqual(ALLOW)
    })

    it('does not hold a reply behind the cold gap', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'cold@c.us' }))
      world.incoming.set('open@c.us', new Date(NOW.getTime() - HOUR))

      expect(await policy.admit(intent({ chatId: 'open@c.us' }))).toEqual(ALLOW)
    })

    it('caps the number look-ups of cold sends per day', async () => {
      const { policy } = setup({ LOOKUPS_PER_DAY: '2' })

      expect(await policy.admitLookup('s1')).toEqual(ALLOW)
      expect(await policy.admitLookup('s1')).toEqual(ALLOW)
      expect(await policy.admitLookup('s1')).toEqual(reject('POLICY_BLOCKED', 'lookups_per_day'))

      jest.setSystemTime(NOW.getTime() + DAY + 1)
      expect(await policy.admitLookup('s1')).toEqual(ALLOW)
    })
  })

  describe('per-chat pacing (rule 3)', () => {
    it('delays a second message to the same chat by PER_CHAT_MIN_INTERVAL_MS', async () => {
      const { policy } = setup()
      await policy.admit(intent())

      expect(await policy.admit(intent())).toEqual(delay(1500, 'per_chat_interval'))

      jest.advanceTimersByTime(1500)
      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('does not pace one chat by what was sent to another', async () => {
      const { policy } = setup()
      await policy.admit(intent({ chatId: 'a@c.us' }))

      expect(await policy.admit(intent({ chatId: 'b@c.us' }))).toEqual(ALLOW)
    })

    it('delays past PER_CHAT_MAX_PER_MINUTE until a token is free', async () => {
      const { policy } = setup({ PER_CHAT_MIN_INTERVAL_MS: '0', PER_CHAT_MAX_PER_MINUTE: '2' })
      await policy.admit(intent())
      await policy.admit(intent())

      expect(await policy.admit(intent())).toEqual(delay(30_000, 'per_chat_per_minute'))

      jest.advanceTimersByTime(30_000)
      expect(await policy.admit(intent())).toEqual(ALLOW)
    })
  })

  describe('session budgets (rule 4)', () => {
    it('smooths a burst into a delay instead of failing', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '3' })

      const { allowed, stopped } = await sendUntilDelayed(policy)

      expect(allowed).toBe(3)
      expect(stopped).toEqual(delay(20_000, 'session_per_minute'))
    })

    it('spends nothing on a delay, so the job asks again and is let through', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'x@c.us' }))

      expect(await policy.admit(intent({ chatId: 'y@c.us' }))).toEqual(
        delay(60_000, 'session_per_minute')
      )
      expect(await policy.admit(intent({ chatId: 'y@c.us' }))).toEqual(
        delay(60_000, 'session_per_minute')
      )

      jest.advanceTimersByTime(60_000)
      expect(await policy.admit(intent({ chatId: 'y@c.us' }))).toEqual(ALLOW)
    })

    it('applies the hourly and the daily budget as well', async () => {
      const hourly = setup({ ...WIDE_CHAT, ...LONG_WAIT, SESSION_MAX_PER_HOUR: '2' })
      expect((await sendUntilDelayed(hourly.policy)).stopped).toEqual(
        delay(1_800_000, 'session_per_hour')
      )

      const daily = setup({ ...WIDE_CHAT, ...LONG_WAIT, SESSION_MAX_PER_DAY: '4' })
      expect((await sendUntilDelayed(daily.policy)).stopped).toEqual(
        delay(DAY / 4, 'session_per_day')
      )
    })

    it('reports the longest wait when several budgets are spent', async () => {
      const { policy } = setup({
        ...WIDE_CHAT,
        ...LONG_WAIT,
        SESSION_MAX_PER_MINUTE: '1',
        SESSION_MAX_PER_HOUR: '1'
      })
      await policy.admit(intent({ chatId: 'x@c.us' }))

      expect(await policy.admit(intent({ chatId: 'y@c.us' }))).toEqual(
        delay(HOUR, 'session_per_hour')
      )
    })

    it('keeps the budgets of one session apart from another', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ sessionId: 's1', chatId: 'x@c.us' }))

      expect(await policy.admit(intent({ sessionId: 's2', chatId: 'x@c.us' }))).toEqual(ALLOW)
    })

    it('lets the session setting override a budget', async () => {
      const { policy, world } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '3' })
      world.settings = { sendPolicy: { sessionMaxPerMinute: 5 } }

      expect((await sendUntilDelayed(policy)).allowed).toBe(5)
    })

    it('starts over after forget (the session was deleted)', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'x@c.us' }))
      await policy.forget('s1')

      expect(await policy.admit(intent({ chatId: 'y@c.us' }))).toEqual(ALLOW)
    })

    it('never spends a budget on a check', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })

      for (let i = 0; i < 5; i++) expect(await policy.check(intent())).toEqual(ALLOW)

      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('never delays at enqueue, even with the budget spent', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'x@c.us' }))

      expect(await policy.check(intent({ chatId: 'y@c.us' }))).toEqual(ALLOW)
    })
  })

  describe('longest wait (rule 9)', () => {
    it('ends the job with POLICY_DELAY_EXCEEDED when the wait would pass SEND_POLICY_MAX_WAIT_MS', async () => {
      const { policy } = setup({
        ...WIDE_CHAT,
        SESSION_MAX_PER_MINUTE: '1',
        SEND_POLICY_MAX_WAIT_MS: '30000'
      })
      await policy.admit(intent({ chatId: 'x@c.us' }))

      expect(await policy.admit(intent({ chatId: 'y@c.us' }))).toEqual(
        reject('POLICY_DELAY_EXCEEDED', 'delay_exceeded')
      )
    })

    it('counts what the job already waited', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'x@c.us' }))

      const fresh = await policy.admit(intent({ chatId: 'y@c.us', waitedMs: 0 }))
      const late = await policy.admit(intent({ chatId: 'y@c.us', waitedMs: 1_800_000 - 59_999 }))

      expect(fresh).toEqual(delay(60_000, 'session_per_minute'))
      expect(late).toEqual(reject('POLICY_DELAY_EXCEEDED', 'delay_exceeded'))
    })

    it('does not spend the budget of a job it ends', async () => {
      const { policy } = setup({
        ...WIDE_CHAT,
        SESSION_MAX_PER_MINUTE: '1',
        SEND_POLICY_MAX_WAIT_MS: '30000'
      })
      await policy.admit(intent({ chatId: 'x@c.us' }))
      await policy.admit(intent({ chatId: 'y@c.us' }))

      jest.advanceTimersByTime(60_000)
      expect(await policy.admit(intent({ chatId: 'z@c.us' }))).toEqual(ALLOW)
    })
  })

  describe('duplicate content (rule 5)', () => {
    const dup = {
      ALLOW_COLD_SENDS: 'true',
      DUPLICATE_RECIPIENTS_THRESHOLD: '3',
      COLD_SEND_MIN_GAP_MS: '0',
      ...WIDE_CHAT
    }
    const offer = (n: number): string => `Oferta ${n}% solo hoy https://tienda.example/o/${n}`

    it('rejects a cold send of text already sent to the threshold of other chats', async () => {
      const { policy, world } = setup(dup)
      world.incomingDefault = null
      for (const chat of ['a', 'b', 'c']) {
        expect(await policy.admit(intent({ chatId: `${chat}@c.us`, body: offer(10) }))).toEqual(
          ALLOW
        )
      }

      const expected = reject('DUPLICATE_CONTENT', 'duplicate_content')
      expect(await policy.admit(intent({ chatId: 'd@c.us', body: offer(25) }))).toEqual(expected)
      expect(await policy.check(intent({ chatId: 'd@c.us', body: offer(25) }))).toEqual(expected)
    })

    it('allows different text, and the same text below the threshold', async () => {
      const { policy, world } = setup(dup)
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us', body: offer(1) }))
      await policy.admit(intent({ chatId: 'b@c.us', body: offer(1) }))

      expect(await policy.admit(intent({ chatId: 'c@c.us', body: offer(1) }))).toEqual(ALLOW)
      expect(await policy.admit(intent({ chatId: 'd@c.us', body: 'otra cosa distinta' }))).toEqual(
        ALLOW
      )
    })

    it('counts a chat once however many times it received the text', async () => {
      const { policy, world } = setup({ ...dup, DUPLICATE_RECIPIENTS_THRESHOLD: '2' })
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us', body: 'hola' }))
      await policy.admit(intent({ chatId: 'a@c.us', body: 'hola' }))
      await policy.admit(intent({ chatId: 'a@c.us', body: 'hola' }))

      expect(await policy.admit(intent({ chatId: 'b@c.us', body: 'hola' }))).toEqual(ALLOW)
    })

    it('stops counting after DUPLICATE_WINDOW_MINUTES', async () => {
      const { policy, world } = setup(dup)
      world.incomingDefault = null
      for (const chat of ['a', 'b', 'c']) {
        await policy.admit(intent({ chatId: `${chat}@c.us`, body: 'hola' }))
      }

      jest.advanceTimersByTime(10 * 60_000 + 1)

      expect(await policy.admit(intent({ chatId: 'd@c.us', body: 'hola' }))).toEqual(ALLOW)
    })

    it('applies to cold sends only, so a reply is never refused for its text', async () => {
      const { policy, world } = setup(dup)
      world.incomingDefault = null
      for (const chat of ['a', 'b', 'c']) {
        await policy.admit(intent({ chatId: `${chat}@c.us`, body: 'gracias' }))
      }
      world.incoming.set('open@c.us', new Date(NOW.getTime() - HOUR))

      expect(await policy.admit(intent({ chatId: 'open@c.us', body: 'gracias' }))).toEqual(ALLOW)
    })

    it('skips the guard for a message without text', async () => {
      const { policy, world } = setup({ ...dup, DUPLICATE_RECIPIENTS_THRESHOLD: '1' })
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us', body: undefined }))

      expect(await policy.admit(intent({ chatId: 'b@c.us', body: undefined }))).toEqual(ALLOW)
    })
  })

  describe('warm-up (rule 6)', () => {
    it('scales the budgets of a session linked today to the start fraction', async () => {
      const { policy, world } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '20' })
      world.linkedAt = NOW

      expect((await sendUntilDelayed(policy)).allowed).toBe(2)
    })

    it('ramps the budgets up as the account ages', async () => {
      const { policy, world } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '20' })
      world.linkedAt = new Date(NOW.getTime() - 7 * DAY)

      // 0.1 + 0.9 * 7 / 14 = 0.55
      expect((await sendUntilDelayed(policy)).allowed).toBe(11)
    })

    it('gives the full budget after WARMUP_DAYS', async () => {
      const { policy, world } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '20' })
      world.linkedAt = new Date(NOW.getTime() - 14 * DAY)

      expect((await sendUntilDelayed(policy)).allowed).toBe(20)
    })

    it('scales the cold budget too, never below one', async () => {
      const { policy, world } = setup({
        ALLOW_COLD_SENDS: 'true',
        COLD_SENDS_PER_DAY: '20',
        COLD_SEND_MIN_GAP_MS: '0',
        ...WIDE_CHAT
      })
      world.linkedAt = NOW
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us' }))
      await policy.admit(intent({ chatId: 'b@c.us' }))

      expect(await policy.admit(intent({ chatId: 'c@c.us' }))).toEqual(
        reject('POLICY_BLOCKED', 'cold_sends_per_day')
      )
    })

    it('treats a session that never linked as brand new', async () => {
      const { policy, world } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '20' })
      world.linkedAt = null

      expect((await sendUntilDelayed(policy)).allowed).toBe(2)
    })
  })

  describe('suppression (rule 7)', () => {
    it('rejects every send to a suppressed chat, even in an open conversation', async () => {
      const { policy, world } = setup()
      world.suppressed.add('a@c.us')

      const expected = reject('RECIPIENT_SUPPRESSED', 'suppressed')
      expect(await policy.check(intent())).toEqual(expected)
      expect(await policy.admit(intent())).toEqual(expected)
      expect(await policy.admit(intent({ chatId: 'b@c.us' }))).toEqual(ALLOW)
    })

    it('puts the chat on the list when its whole message is an opt-out keyword', async () => {
      const { policy, world, suppressions } = setup()
      world.settings = { sendPolicy: { optOutKeywords: ['stop', 'BAJA'] } }

      expect(await policy.handleIncoming('s1', 'a@c.us', '  Stop ')).toBe(true)
      expect(suppressions.add).toHaveBeenCalledWith({
        sessionId: 's1',
        chatId: 'a@c.us',
        reason: 'opt_out'
      })
      expect(await policy.admit(intent())).toEqual(reject('RECIPIENT_SUPPRESSED', 'suppressed'))
    })

    it('reports a chat that was already on the list as not new', async () => {
      const { policy, world } = setup()
      world.settings = { sendPolicy: { optOutKeywords: ['stop'] } }
      await policy.handleIncoming('s1', 'a@c.us', 'stop')

      expect(await policy.handleIncoming('s1', 'a@c.us', 'stop')).toBe(false)
    })

    it('ignores a message that only contains a keyword', async () => {
      const { policy, world, suppressions } = setup()
      world.settings = { sendPolicy: { optOutKeywords: ['stop'] } }

      expect(await policy.handleIncoming('s1', 'a@c.us', 'no me hagas stop')).toBe(false)
      expect(suppressions.add).not.toHaveBeenCalled()
    })

    it('does nothing by default, because the keyword list is empty', async () => {
      const { policy, suppressions } = setup()

      expect(await policy.handleIncoming('s1', 'a@c.us', 'stop')).toBe(false)
      expect(suppressions.add).not.toHaveBeenCalled()
    })
  })

  describe('unreachable recipient (rule 8)', () => {
    const cold = { ALLOW_COLD_SENDS: 'true', ...WIDE_CHAT }
    // Five messages of ours at ack 1, the oldest 80 h old; the contact wrote 100 h ago
    const stuck = (): OutgoingState[] =>
      [10, 20, 40, 60, 80].map(hours => ({
        ack: 1,
        sentAt: new Date(NOW.getTime() - hours * HOUR)
      }))

    it('never flags a recipient who wrote recently, however long our messages sit at ack 1', async () => {
      const { policy, world, suppressions } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - HOUR)
      world.outgoing = stuck()

      expect(await policy.check(intent())).toEqual(ALLOW)
      expect(await policy.admit(intent())).toEqual(ALLOW)
      expect(suppressions.add).not.toHaveBeenCalled()
    })

    it('flags a recipient silent for 72 h whose last 5 messages are all undelivered', async () => {
      const { policy, world, suppressions } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()

      const expected = reject('RECIPIENT_UNREACHABLE', 'unreachable')
      expect(await policy.check(intent())).toEqual(expected)
      expect(await policy.admit(intent())).toEqual(expected)
      expect(suppressions.add).not.toHaveBeenCalled()
    })

    it('flags a contact who never wrote', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = null
      world.outgoing = stuck()

      expect((await policy.check(intent())).decision).toBe('reject')
    })

    it('waits for the silence to last the full age', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 71 * HOUR)
      world.outgoing = stuck()

      expect(await policy.check(intent())).toEqual(ALLOW)
    })

    it('waits for the full streak of undelivered messages', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck().slice(0, 4)

      expect(await policy.check(intent())).toEqual(ALLOW)
    })

    it('waits until the oldest of the streak is as old as the age', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck().map(m => ({ ...m, sentAt: new Date(NOW.getTime() - 71 * HOUR) }))

      expect(await policy.check(intent())).toEqual(ALLOW)
    })

    it('clears when any of the last messages was delivered', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()
      expect((await policy.check(intent())).decision).toBe('reject')

      world.outgoing = [{ ack: 2, sentAt: new Date(NOW.getTime() - HOUR) }, ...stuck().slice(0, 4)]

      expect(await policy.check(intent())).toEqual(ALLOW)
    })

    it('clears at once when the contact writes, and replies were never affected', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()
      expect((await policy.check(intent())).decision).toBe('reject')

      world.incomingDefault = new Date(NOW.getTime() - 60_000)

      expect(await policy.check(intent())).toEqual(ALLOW)
      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('does not take a message of unknown ack for an undelivered one', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck().map((m, i) => (i === 0 ? { ...m, ack: null } : m))

      expect(await policy.check(intent())).toEqual(ALLOW)
    })

    it('counts an error ack as undelivered', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck().map((m, i) => (i === 0 ? { ...m, ack: -1 } : m))

      expect((await policy.check(intent())).decision).toBe('reject')
    })
  })

  describe('health throttle (rule 9)', () => {
    const health = { ...WIDE_CHAT, HEALTH_WINDOW: '10', SESSION_MAX_PER_MINUTE: '20' }
    // One result after the other, as the queue reports them
    const feed = async (
      policy: SendPolicyService,
      outcomes: ('ok' | 'hard_failure')[]
    ): Promise<boolean[]> => {
      const tripped: boolean[] = []
      for (const outcome of outcomes) tripped.push(await policy.recordOutcome('s1', outcome))
      return tripped
    }
    const oks = (n: number): 'ok'[] => Array<'ok'>(n).fill('ok')
    const fails = (n: number): 'hard_failure'[] => Array<'hard_failure'>(n).fill('hard_failure')

    it('is quiet while the window holds only good results, however many sends sit at ack 1', async () => {
      const { policy } = setup(health)
      await policy.admit(intent())

      expect(await feed(policy, oks(30))).not.toContain(true)
    })

    it('trips once, when the bad ratio of a full window passes the maximum', async () => {
      const { policy } = setup(health)
      await policy.admit(intent())

      const results = await feed(policy, [...oks(7), ...fails(3)])

      expect(results.filter(Boolean)).toHaveLength(1)
      expect(results.at(-1)).toBe(true)
    })

    it('waits for HEALTH_MIN_SAMPLES, and does not trip at exactly the maximum ratio', async () => {
      const { policy } = setup(health)
      await policy.admit(intent())

      // Nine results, three of them bad, are not enough yet
      expect(await feed(policy, [...fails(3), ...oks(6)])).not.toContain(true)

      const { policy: other } = setup(health)
      await other.admit(intent())
      expect(await feed(other, [...fails(2), ...oks(8)])).not.toContain(true)
    })

    it('trips a young session after HEALTH_MIN_SAMPLES results, before the window is full', async () => {
      const { policy } = setup({ ...WIDE_CHAT, HEALTH_WINDOW: '50', HEALTH_MIN_SAMPLES: '10' })
      await policy.admit(intent())

      const results = await feed(policy, [...oks(5), ...fails(5)])

      expect(results.indexOf(true)).toBe(9)
    })

    it('never needs more samples than the window holds', async () => {
      const { policy } = setup({ ...WIDE_CHAT, HEALTH_WINDOW: '5', HEALTH_MIN_SAMPLES: '100' })
      await policy.admit(intent())

      expect((await feed(policy, [...oks(2), ...fails(3)])).at(-1)).toBe(true)
    })

    it('counts a result of a session that has not sent yet', async () => {
      const { policy } = setup(health)

      expect(await feed(policy, [...oks(7), ...fails(3)])).toContain(true)
    })

    it('halves the budgets and keeps delaying instead of refusing', async () => {
      const { policy } = setup(health)
      await policy.admit(intent({ chatId: 'first@c.us' }))
      await feed(policy, [...oks(7), ...fails(3)])

      const { allowed, stopped } = await sendUntilDelayed(policy)

      expect(allowed).toBe(10)
      expect(stopped.decision).toBe('delay')
    })

    it('does not trip again while throttled', async () => {
      const { policy } = setup(health)
      await policy.admit(intent())
      await feed(policy, [...oks(7), ...fails(3)])

      expect(await feed(policy, fails(20))).not.toContain(true)
    })

    it('recovers the full budgets after HEALTH_COOLDOWN_MIN, with a fresh window', async () => {
      const { policy } = setup(health)
      await policy.admit(intent())
      await feed(policy, [...oks(7), ...fails(3)])

      jest.advanceTimersByTime(31 * 60_000)

      expect(await feed(policy, fails(5))).not.toContain(true)
      expect((await sendUntilDelayed(policy)).allowed).toBe(20)
    })

    it('can trip again after recovering if the failures come back', async () => {
      const { policy } = setup(health)
      await policy.admit(intent())
      await feed(policy, [...oks(7), ...fails(3)])
      jest.advanceTimersByTime(31 * 60_000)

      expect((await feed(policy, [...oks(7), ...fails(3)])).at(-1)).toBe(true)
    })

    it('pushes the cold budget down with the rest', async () => {
      const { policy, world } = setup({
        ...health,
        ALLOW_COLD_SENDS: 'true',
        COLD_SENDS_PER_DAY: '4',
        COLD_SEND_MIN_GAP_MS: '0'
      })
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us' }))
      await feed(policy, [...oks(7), ...fails(3)])
      await policy.admit(intent({ chatId: 'b@c.us' }))

      expect(await policy.admit(intent({ chatId: 'c@c.us' }))).toEqual(
        reject('POLICY_BLOCKED', 'cold_sends_per_day')
      )
    })
  })

  describe('quiet hours (rule 10)', () => {
    const quiet = { quietHours: { from: '22:00', to: '07:00', timezone: 'UTC' } }
    const cold = { ALLOW_COLD_SENDS: 'true', SEND_POLICY_MAX_WAIT_MS: String(DAY), ...WIDE_CHAT }

    it('delays a cold send to the end of the window', async () => {
      const { policy, world } = setup(cold)
      world.settings = { sendPolicy: quiet }
      world.incomingDefault = null

      // 23:00 -> 07:00
      expect(await policy.admit(intent())).toEqual(delay(8 * HOUR, 'quiet_hours'))

      jest.setSystemTime(NOW.getTime() + 8 * HOUR)
      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('never holds a reply', async () => {
      const { policy, world } = setup(cold)
      world.settings = { sendPolicy: quiet }

      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('lets a cold send through outside the window', async () => {
      const { policy, world } = setup(cold)
      world.settings = {
        sendPolicy: { quietHours: { from: '01:00', to: '05:00', timezone: 'UTC' } }
      }
      world.incomingDefault = null

      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('is not cut short by SEND_POLICY_MAX_WAIT_MS, because waiting for the window is the rule', async () => {
      const { policy, world } = setup({ ALLOW_COLD_SENDS: 'true', ...WIDE_CHAT })
      world.settings = { sendPolicy: quiet }
      world.incomingDefault = null

      expect(await policy.admit(intent())).toEqual(delay(8 * HOUR, 'quiet_hours'))
    })

    it('still ends a job whose other wait is too long, quiet hours or not', async () => {
      const { policy, world } = setup({
        ALLOW_COLD_SENDS: 'true',
        ...WIDE_CHAT,
        SESSION_MAX_PER_HOUR: '1',
        SEND_POLICY_MAX_WAIT_MS: String(HOUR)
      })
      world.settings = { sendPolicy: quiet }
      await policy.admit(intent({ chatId: 'warm@c.us' }))
      world.incomingDefault = null

      expect(await policy.admit(intent({ chatId: 'cold@c.us', waitedMs: HOUR }))).toEqual(
        reject('POLICY_DELAY_EXCEEDED', 'delay_exceeded')
      )
    })

    it('does not reject at enqueue', async () => {
      const { policy, world } = setup(cold)
      world.settings = { sendPolicy: quiet }
      world.incomingDefault = null

      expect(await policy.check(intent())).toEqual(ALLOW)
    })
  })

  describe('state that survives a restart', () => {
    const cold = { ALLOW_COLD_SENDS: 'true', ...WIDE_CHAT }

    it('does not hand the session budget out again after a restart', async () => {
      const { policy, build } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '3' })
      await policy.admit(intent({ chatId: 'a@c.us' }))
      await policy.admit(intent({ chatId: 'b@c.us' }))
      await policy.admit(intent({ chatId: 'c@c.us' }))

      const restarted = build()

      expect(await restarted.admit(intent({ chatId: 'd@c.us' }))).toEqual(
        delay(20_000, 'session_per_minute')
      )
    })

    it('keeps refilling from the saved time, not from the restart', async () => {
      const { policy, build } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '3' })
      for (const chat of ['a', 'b', 'c']) await policy.admit(intent({ chatId: `${chat}@c.us` }))

      jest.setSystemTime(NOW.getTime() + 20_000)

      expect(await build().admit(intent({ chatId: 'd@c.us' }))).toEqual(ALLOW)
    })

    it('remembers the cold chats of the day, the gap and the look-ups', async () => {
      const { policy, build, world } = setup({
        ...cold,
        COLD_SENDS_PER_DAY: '1',
        COLD_SEND_MIN_GAP_MS: '60000',
        LOOKUPS_PER_DAY: '1'
      })
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us' }))
      await policy.admitLookup('s1')

      const restarted = build()

      expect(await restarted.admit(intent({ chatId: 'b@c.us' }))).toEqual(
        reject('POLICY_BLOCKED', 'cold_sends_per_day')
      )
      expect(await restarted.admitLookup('s1')).toEqual(reject('POLICY_BLOCKED', 'lookups_per_day'))
    })

    it('remembers the content already sent', async () => {
      const { policy, build, world } = setup({
        ...cold,
        DUPLICATE_RECIPIENTS_THRESHOLD: '2',
        COLD_SEND_MIN_GAP_MS: '0'
      })
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us', body: 'oferta 10' }))
      await policy.admit(intent({ chatId: 'b@c.us', body: 'oferta 20' }))

      expect(await build().admit(intent({ chatId: 'c@c.us', body: 'oferta 30' }))).toEqual(
        reject('DUPLICATE_CONTENT', 'duplicate_content')
      )
    })

    it('remembers a health throttle that is still running', async () => {
      const { policy, build } = setup({
        ...WIDE_CHAT,
        HEALTH_WINDOW: '10',
        SESSION_MAX_PER_MINUTE: '20'
      })
      await policy.admit(intent())
      for (const outcome of [
        ...Array<'ok'>(7).fill('ok'),
        ...Array<'hard_failure'>(3).fill('hard_failure')
      ]) {
        await policy.recordOutcome('s1', outcome)
      }

      const restarted = build()

      expect((await sendUntilDelayed(restarted)).allowed).toBe(10)
    })

    it('never saves the text of a message, only a digest', async () => {
      const { policy, store } = setup()
      await policy.admit(intent({ body: 'Mi número de tarjeta es 4111 1111 1111 1111' }))

      const saved = store.states.get('s1') ?? ''

      expect(saved).not.toContain('tarjeta')
      expect(saved).not.toContain('4111')
      expect(saved).toMatch(/[0-9a-f]{64}/)
    })

    it('forgets a session when it is deleted', async () => {
      const { policy, build, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'a@c.us' }))
      await policy.forget('s1')

      expect(store.states.has('s1')).toBe(false)
      expect(await build().admit(intent({ chatId: 'b@c.us' }))).toEqual(ALLOW)
    })
  })

  describe('when the state store fails', () => {
    it('delays instead of allowing when the state cannot be read', async () => {
      const { policy, store } = setup()
      store.failing = true

      expect(await policy.admit(intent())).toEqual(delay(5000, 'state_unavailable'))
    })

    it('delays when the spending cannot be saved, and spends nothing in memory', async () => {
      const { policy, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'a@c.us' }))
      jest.setSystemTime(NOW.getTime() + 60_000)
      store.failing = true

      expect(await policy.admit(intent({ chatId: 'b@c.us' }))).toEqual(
        delay(5000, 'state_unavailable')
      )

      store.failing = false
      expect(await policy.admit(intent({ chatId: 'b@c.us' }))).toEqual(ALLOW)
    })

    it('ends the job when the store stays down past the maximum wait', async () => {
      const { policy, store } = setup()
      store.failing = true

      expect(await policy.admit(intent({ waitedMs: 1_800_000 - 1000 }))).toEqual(
        reject('POLICY_DELAY_EXCEEDED', 'delay_exceeded')
      )
    })

    it('still refuses what needs no state, and lets the enqueue through otherwise', async () => {
      const { policy, world, store } = setup()
      store.failing = true

      expect(await policy.check(intent())).toEqual(ALLOW)
      world.suppressed.add('a@c.us')
      expect(await policy.admit(intent())).toEqual(reject('RECIPIENT_SUPPRESSED', 'suppressed'))
    })

    it('starts a session throttled, not with full budgets, when the saved state is unreadable', async () => {
      const { policy, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '20' })
      store.states.set('s1', '{not json')
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

      const { allowed } = await sendUntilDelayed(policy)

      expect(allowed).toBe(10)
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it('keeps the throttle for the cooldown and then recovers', async () => {
      const { policy, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '20' })
      store.states.set('s1', JSON.stringify({ version: 1, wrong: true }))
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      await policy.admit(intent())

      jest.setSystemTime(NOW.getTime() + 31 * 60_000)

      expect((await sendUntilDelayed(policy)).allowed).toBe(20)
    })

    it('delays instead of hanging when the store never answers', async () => {
      const { policy, store } = setup()
      store.hanging = true

      const answer = policy.admit(intent())
      // Lets the call reach the store, where the deadline starts, and then passes it
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(2000)

      expect(await answer).toEqual(delay(5000, 'state_unavailable'))
    })

    it('lets the next dispatch of the session go on after a hung call', async () => {
      const { policy, store } = setup()
      store.hanging = true
      const first = policy.admit(intent())
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(2000)
      await first

      store.hanging = false

      expect(await policy.admit(intent())).toEqual(ALLOW)
    })

    it('turns a database failure at dispatch into a delay, and throws it at enqueue', async () => {
      const { policy, world } = setup()
      world.databaseDown = true
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

      expect(await policy.admit(intent())).toEqual(delay(5000, 'state_unavailable'))
      await expect(policy.check(intent())).rejects.toThrow('database down')
      error.mockRestore()
    })

    it('reads the store again after a save failed, because it may have reached Redis', async () => {
      const { policy, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'a@c.us' }))
      jest.setSystemTime(NOW.getTime() + 60_000)
      const real = store.save.bind(store)
      // Redis stores the state and then the connection drops before the answer
      store.save = async (...args) => {
        await real(...args)
        throw new Error('connection lost')
      }
      expect((await policy.admit(intent({ chatId: 'b@c.us' }))).decision).toBe('delay')
      store.save = real

      // Redis has the spending of b, so a second send in the same minute waits
      expect(await policy.admit(intent({ chatId: 'c@c.us' }))).toMatchObject({
        decision: 'delay',
        rule: 'session_per_minute'
      })
    })
  })

  describe('a slow read of the state', () => {
    it('does not give back a budget that was spent while a check was still reading', async () => {
      const { policy, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      const release = store.releaseNextLoad()

      // The check starts first on a cold cache, and its read is slow
      const slow = policy.check(intent({ chatId: 'a@c.us' }))
      await Promise.resolve()
      const spent = await policy.admit(intent({ chatId: 'a@c.us' }))
      release()
      await slow

      expect(spent).toEqual(ALLOW)
      expect(await policy.admit(intent({ chatId: 'b@c.us' }))).toMatchObject({
        decision: 'delay',
        rule: 'session_per_minute'
      })
    })

    it('does not bring a deleted session back from a read that was in flight', async () => {
      const { policy, build, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'a@c.us' }))
      // A restarted process: nothing in memory, the spent budget in the store
      const restarted = build()
      const release = store.releaseNextLoad()

      const slow = restarted.check(intent({ chatId: 'a@c.us' }))
      await Promise.resolve()
      await restarted.forget('s1')
      release()
      await slow

      expect(await restarted.admit(intent({ chatId: 'b@c.us' }))).toEqual(ALLOW)
    })
  })

  describe('forgetting a session while it is being read', () => {
    it('does not keep what a read cached during the delete', async () => {
      const { policy, build, store } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'a@c.us' }))
      const restarted = build()
      const releaseDelete = store.releaseNextDelete()

      const forgetting = restarted.forget('s1')
      await Promise.resolve()
      // The delete has not reached the store yet, so this read still finds the old state
      await restarted.check(intent({ chatId: 'a@c.us' }))
      releaseDelete()
      await forgetting

      expect(await restarted.admit(intent({ chatId: 'b@c.us' }))).toEqual(ALLOW)
    })
  })

  describe('a database that hangs', () => {
    it('delays instead of holding the session for ever', async () => {
      const { policy, world } = setup()
      world.databaseHangs = true

      const answer = policy.admit(intent())
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(5000)

      expect(await answer).toEqual(delay(5000, 'state_unavailable'))
    })

    it('lets the next send of the session run after the hung one gave up', async () => {
      const { policy, world } = setup()
      world.databaseHangs = true
      const first = policy.admit(intent())
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(5000)
      await first

      world.databaseHangs = false

      expect(await policy.admit(intent())).toEqual(ALLOW)
    })
  })

  describe('opt-out when the settings are unusable', () => {
    it('still honors the keywords of a session whose other settings are invalid', async () => {
      const { policy, world, suppressions } = setup()
      world.settings = { sendPolicy: { optOutKeywords: ['stop'], sessionMaxPerDay: 'many' } }

      expect(await policy.handleIncoming('s1', 'a@c.us', 'STOP')).toBe(true)
      expect(suppressions.add).toHaveBeenCalled()
    })

    it('throws, so the pipeline can retry, when the keywords cannot be read at all', async () => {
      const { policy, world, suppressions } = setup()
      world.settings = { sendPolicy: { optOutKeywords: 'stop' } }
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

      await expect(policy.handleIncoming('s1', 'a@c.us', 'stop')).rejects.toThrow()
      expect(suppressions.add).not.toHaveBeenCalled()
      error.mockRestore()
    })

    it('has nothing to honor for a session that does not exist', async () => {
      const { policy, world } = setup()
      world.missing = true

      expect(await policy.handleIncoming('s1', 'a@c.us', 'stop')).toBe(false)
    })
  })

  describe('a settings change', () => {
    it('keeps the last valid settings when the new ones are unusable', async () => {
      const { policy, world } = setup({ ALLOW_COLD_SENDS: 'true' })
      world.incomingDefault = null
      world.settings = { sendPolicy: { allowColdSends: false } }
      expect((await policy.admit(intent())).decision).toBe('reject')

      world.settings = { sendPolicy: { allowColdSends: 'oops' } }
      policy.invalidateSettings('s1')

      expect(await policy.admit(intent())).toEqual(reject('POLICY_BLOCKED', 'cold_sends_disabled'))
    })

    it('does not keep the old settings from a read that was in flight when the change came', async () => {
      const { policy, world, sessions } = setup({ ALLOW_COLD_SENDS: 'true' })
      world.incomingDefault = null
      world.settings = { sendPolicy: { allowColdSends: false } }
      let release!: () => void
      world.heldSessionReads.push(
        new Promise<void>(done => {
          release = done
        })
      )

      // The read has the old row in hand and is slow; the settings change meanwhile
      const slow = policy.check(intent())
      await jest.advanceTimersByTimeAsync(0)
      expect(sessions.findById).toHaveBeenCalledTimes(1)
      world.settings = { sendPolicy: { allowColdSends: true } }
      policy.invalidateSettings('s1')
      release()
      await slow

      expect(await policy.check(intent())).toEqual(ALLOW)
    })
  })

  describe('a recipient that is not a WhatsApp id', () => {
    it('refuses an id longer than the state can hold, so it cannot make the state unreadable', async () => {
      const { policy, store } = setup()
      const chatId = `${'9'.repeat(200)}@c.us`

      expect(await policy.check(intent({ chatId }))).toEqual(
        reject('POLICY_BLOCKED', 'invalid_chat_id')
      )
      expect(await policy.admit(intent({ chatId }))).toEqual(
        reject('POLICY_BLOCKED', 'invalid_chat_id')
      )
      expect(store.states.size).toBe(0)
    })
  })

  describe('clocks', () => {
    it('does not wait out a time stored in the future after the clock was set back', async () => {
      const { policy, world } = setup({ ALLOW_COLD_SENDS: 'true', ...WIDE_CHAT })
      world.incomingDefault = null
      await policy.admit(intent({ chatId: 'a@c.us' }))
      jest.setSystemTime(NOW.getTime() - 10 * HOUR)

      expect(await policy.admit(intent({ chatId: 'b@c.us' }))).toEqual(
        delay(60_000, 'cold_send_gap')
      )
    })

    it('opens a conversation by arrival, so a contact message stamped in the future is not open for ever', async () => {
      const { policy, world } = setup()
      world.incomingDefault = new Date(NOW.getTime() + 100 * HOUR)

      expect(await policy.check(intent())).toEqual(ALLOW)

      jest.setSystemTime(NOW.getTime() + 25 * HOUR)
      world.incomingDefault = new Date(NOW.getTime() - 24 * HOUR)
      expect(await policy.check(intent())).toEqual(reject('POLICY_BLOCKED', 'cold_sends_disabled'))
    })
  })

  describe('concurrent calls', () => {
    it('never spends one token twice when two sends of a session are asked together', async () => {
      const { policy } = setup({ ...WIDE_CHAT, SESSION_MAX_PER_MINUTE: '1' })

      const [first, second] = await Promise.all([
        policy.admit(intent({ chatId: 'a@c.us' })),
        policy.admit(intent({ chatId: 'b@c.us' }))
      ])

      expect([first.decision, second.decision].sort()).toEqual(['allow', 'delay'])
    })

    it('counts every result when many arrive together', async () => {
      const { policy } = setup({ ...WIDE_CHAT, HEALTH_WINDOW: '10' })
      await policy.admit(intent())

      const results = await Promise.all(
        [...Array<'ok'>(7).fill('ok'), ...Array<'hard_failure'>(3).fill('hard_failure')].map(o =>
          policy.recordOutcome('s1', o)
        )
      )

      expect(results.filter(Boolean)).toHaveLength(1)
    })
  })

  describe('settings of the session', () => {
    it('reads them once for a while, not on every message', async () => {
      const { policy, sessions } = setup()

      await policy.admit(intent({ chatId: 'a@c.us' }))
      await policy.check(intent({ chatId: 'b@c.us' }))
      await policy.handleIncoming('s1', 'c@c.us', 'hola')

      expect(sessions.findById).toHaveBeenCalledTimes(1)
    })

    it('reads them again after the time to live', async () => {
      const { policy, sessions } = setup()
      await policy.check(intent())

      jest.setSystemTime(NOW.getTime() + 31_000)
      await policy.check(intent())

      expect(sessions.findById).toHaveBeenCalledTimes(2)
    })

    it('reads them again at once when told they changed', async () => {
      const { policy, world } = setup()
      world.incomingDefault = null
      expect((await policy.check(intent())).decision).toBe('reject')

      world.settings = { sendPolicy: { allowColdSends: true } }
      policy.invalidateSettings('s1')

      expect(await policy.check(intent())).toEqual(ALLOW)
    })
  })

  describe('reachability events', () => {
    const cold = { ALLOW_COLD_SENDS: 'true', ...WIDE_CHAT }
    const stuck = (): OutgoingState[] =>
      [10, 20, 40, 60, 80].map(hours => ({
        ack: 1,
        sentAt: new Date(NOW.getTime() - hours * HOUR)
      }))

    it('tells once when a chat becomes unreachable', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()
      const changes: unknown[] = []
      policy.onReachabilityChange(change => changes.push(change))

      await policy.check(intent())
      await policy.admit(intent())

      expect(changes).toEqual([{ sessionId: 's1', chatId: 'a@c.us', unreachable: true }])
    })

    it('tells when the flag clears because a message was delivered', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()
      await policy.check(intent())
      const changes: unknown[] = []
      policy.onReachabilityChange(change => changes.push(change))

      world.outgoing = [{ ack: 2, sentAt: new Date(NOW.getTime() - HOUR) }, ...stuck().slice(0, 4)]
      await policy.check(intent())

      expect(changes).toEqual([{ sessionId: 's1', chatId: 'a@c.us', unreachable: false }])
    })

    it('tells when the contact writes, through handleIncoming', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()
      await policy.check(intent())
      const changes: unknown[] = []
      policy.onReachabilityChange(change => changes.push(change))

      await policy.handleIncoming('s1', 'a@c.us', 'hola')
      await policy.handleIncoming('s1', 'a@c.us', 'otra vez')

      expect(changes).toEqual([{ sessionId: 's1', chatId: 'a@c.us', unreachable: false }])
    })

    it('says nothing for a chat that was never flagged', async () => {
      const { policy } = setup(cold)
      const changes: unknown[] = []
      policy.onReachabilityChange(change => changes.push(change))

      await policy.check(intent())
      await policy.handleIncoming('s1', 'a@c.us', 'hola')

      expect(changes).toEqual([])
    })

    it('keeps deciding from the messages when the flag cannot be stored', async () => {
      const { policy, world, store } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()
      store.failing = true

      expect(await policy.check(intent())).toEqual(reject('RECIPIENT_UNREACHABLE', 'unreachable'))
    })

    it('stops calling a listener that was removed, and survives one that throws', async () => {
      const { policy, world } = setup(cold)
      world.incomingDefault = new Date(NOW.getTime() - 100 * HOUR)
      world.outgoing = stuck()
      const seen: unknown[] = []
      policy.onReachabilityChange(() => {
        throw new Error('listener bug')
      })
      const off = policy.onReachabilityChange(change => seen.push(change))
      off()

      await expect(policy.check(intent())).resolves.toEqual(
        reject('RECIPIENT_UNREACHABLE', 'unreachable')
      )
      expect(seen).toEqual([])
    })
  })

  describe('rule order', () => {
    it('says suppressed before anything else', async () => {
      const { policy, world } = setup()
      world.incomingDefault = null
      world.suppressed.add('a@c.us')

      expect(await policy.check(intent())).toEqual(reject('RECIPIENT_SUPPRESSED', 'suppressed'))
    })

    it('refuses before it delays', async () => {
      const { policy, world } = setup({ SESSION_MAX_PER_MINUTE: '1' })
      await policy.admit(intent({ chatId: 'x@c.us' }))
      world.suppressed.add('a@c.us')

      expect((await policy.admit(intent())).decision).toBe('reject')
    })
  })
})
