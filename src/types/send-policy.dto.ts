import { z } from 'zod'

import { SEND_POLICY_LIMITS as LIMITS } from '../config/send-policy-limits.js'

// Every number has a ceiling: a limit set to a billion would switch the rule off, and the same
// numbers size the lists of the saved state
const count = (min: number, max: number): z.ZodNumber => z.number().int().min(min).max(max)

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm, 24-hour')

const timezone = z.string().refine(
  name => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: name })
      return true
    } catch {
      return false
    }
  },
  { message: 'Use an IANA time zone, e.g. America/Mexico_City' }
)

export const QuietHours = z.strictObject({
  from: clock.describe('Start of the quiet window, HH:mm'),
  to: clock.describe('End of the quiet window, HH:mm; earlier than "from" means past midnight'),
  timezone: timezone.describe('IANA time zone the window is read in')
})
export type QuietHours = z.infer<typeof QuietHours>

// The part of `Session.settings.sendPolicy` that overrides the environment defaults of the send
// policy (TDD §6.8.1). A key left out keeps the default.
export const SendPolicySettings = z.strictObject({
  allowColdSends: z.boolean().optional(),
  coldSendsPerDay: count(0, LIMITS.coldSendsPerDay).optional(),
  coldSendMinGapMs: count(0, LIMITS.intervalMs).optional(),
  lookupsPerDay: count(0, LIMITS.lookupsPerDay).optional(),
  perChatMinIntervalMs: count(0, LIMITS.intervalMs).optional(),
  perChatMaxPerMinute: count(1, LIMITS.perChatMaxPerMinute).optional(),
  sessionMaxPerMinute: count(1, LIMITS.sessionMaxPerMinute).optional(),
  sessionMaxPerHour: count(1, LIMITS.sessionMaxPerHour).optional(),
  sessionMaxPerDay: count(1, LIMITS.sessionMaxPerDay).optional(),
  optOutKeywords: z
    .array(z.string().trim().min(1).max(64))
    .max(50)
    .optional()
    .describe(
      'Whole incoming messages that put the chat on the suppression list; empty by default'
    ),
  quietHours: QuietHours.optional()
})
export type SendPolicySettings = z.infer<typeof SendPolicySettings>

// Which rule produced a decision; it is `details.rule` of a POLICY_BLOCKED answer and the `rule`
// label of the policy metrics
export const PolicyRule = {
  SUPPRESSED: 'suppressed',
  COLD_SENDS_DISABLED: 'cold_sends_disabled',
  COLD_SENDS_PER_DAY: 'cold_sends_per_day',
  COLD_SEND_GAP: 'cold_send_gap',
  LOOKUPS_PER_DAY: 'lookups_per_day',
  UNREACHABLE: 'unreachable',
  DUPLICATE_CONTENT: 'duplicate_content',
  PER_CHAT_INTERVAL: 'per_chat_interval',
  PER_CHAT_PER_MINUTE: 'per_chat_per_minute',
  SESSION_PER_MINUTE: 'session_per_minute',
  SESSION_PER_HOUR: 'session_per_hour',
  SESSION_PER_DAY: 'session_per_day',
  QUIET_HOURS: 'quiet_hours',
  INVALID_CHAT_ID: 'invalid_chat_id',
  STATE_UNAVAILABLE: 'state_unavailable',
  SETTINGS_UNAVAILABLE: 'settings_unavailable',
  DELAY_EXCEEDED: 'delay_exceeded'
} as const
export type PolicyRule = (typeof PolicyRule)[keyof typeof PolicyRule]

export type PolicyRejectCode =
  | 'POLICY_BLOCKED'
  | 'DUPLICATE_CONTENT'
  | 'RECIPIENT_SUPPRESSED'
  | 'RECIPIENT_UNREACHABLE'
  | 'POLICY_DELAY_EXCEEDED'

export type PolicyDecision =
  | { decision: 'allow' }
  // The job is queued again and tried after `delayMs`; the caller never sees an error for pacing
  | { decision: 'delay'; delayMs: number; rule: PolicyRule }
  | { decision: 'reject'; code: PolicyRejectCode; rule: PolicyRule }
