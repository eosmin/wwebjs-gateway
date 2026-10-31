import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { isWaId, phoneDigits } from '../common/lib/wa-id.js'
import { MAX_CHAT_ID_LENGTH } from '../services/send-policy.state.js'

import { QuietHours, SendPolicySettings } from './send-policy.dto.js'
import { SessionId } from './sessions.dto.js'

const isoDate = z.iso.datetime()
const count = z.number().int().nonnegative()

// The limits in force: the environment defaults with the overrides of the session on top
export const EffectiveSendPolicy = z.strictObject({
  allowColdSends: z.boolean().describe('Whether a chat that has not written to us may be messaged'),
  coldSendsPerDay: count.describe('New chats that may be messaged in 24 hours'),
  coldSendMinGapMs: count.describe('Least time between the first messages to two new chats'),
  lookupsPerDay: count.describe('Number look-ups that are not cached, in 24 hours'),
  perChatMinIntervalMs: count.describe('Least time between two messages to the same chat'),
  perChatMaxPerMinute: count,
  sessionMaxPerMinute: count,
  sessionMaxPerHour: count,
  sessionMaxPerDay: count,
  optOutKeywords: z
    .array(z.string())
    .describe('Whole incoming messages that suppress the chat, as they are compared (normalized)'),
  quietHours: QuietHours.nullable().describe('Window with no cold sends; null when there is none')
})
export type EffectiveSendPolicy = z.infer<typeof EffectiveSendPolicy>
export class EffectiveSendPolicyDto extends createZodDto(EffectiveSendPolicy) {}

export const SendPolicyView = z.strictObject({
  effective: EffectiveSendPolicy,
  overrides: SendPolicySettings.describe(
    'What the session sets itself; every other limit comes from the environment'
  )
})
export class SendPolicyViewDto extends createZodDto(SendPolicyView) {}

// PUT replaces the overrides as a whole: a limit left out goes back to its environment default
export class SendPolicyBodyDto extends createZodDto(SendPolicySettings) {}

const budget = z.strictObject({ used: count, limit: count })
const bucketLevel = z.strictObject({
  available: count.describe('Messages that may go out right now without waiting'),
  limit: count
})

export const SendPolicyUsage = z.strictObject({
  at: isoDate,
  factor: z
    .number()
    .describe('Scale applied to every count budget: the warm-up ramp, halved while throttled'),
  warmup: z.strictObject({
    factor: z.number().describe('1 once the warm-up is over'),
    linkedAt: isoDate.nullable(),
    days: count
  }),
  throttle: z.strictObject({
    active: z.boolean().describe('The health throttle is halving the budgets'),
    until: isoDate.nullable()
  }),
  health: z.strictObject({
    samples: count.describe('Results in the window of the health score'),
    hardFailures: count,
    maxBadRatio: z.number(),
    minSamples: count
  }),
  coldSends: budget.describe('New chats messaged in the last 24 hours'),
  lookups: budget.describe('Number look-ups that were not cached, in the last 24 hours'),
  buckets: z.strictObject({
    perMinute: bucketLevel,
    perHour: bucketLevel,
    perDay: bucketLevel
  }),
  suppressedChats: count
})
export class SendPolicyUsageDto extends createZodDto(SendPolicyUsage) {}

export const SuppressionReason = z.enum(['manual', 'opt_out'])

export const Suppression = z.strictObject({
  chatId: z.string(),
  reason: SuppressionReason,
  note: z.string().nullable(),
  createdAt: isoDate
})
export class SuppressionDto extends createZodDto(Suppression) {}

export const SuppressionList = z.strictObject({
  items: z.array(Suppression),
  nextCursor: z.string().nullable().describe('The `cursor` of the next page; null on the last one')
})
export class SuppressionListDto extends createZodDto(SuppressionList) {}

export const SuppressionListQuery = z.strictObject({
  cursor: z.string().min(1).max(512).optional().describe('The `nextCursor` of the previous page'),
  limit: z.coerce.number().int().min(1).max(500).default(100)
})
export class SuppressionListQueryDto extends createZodDto(SuppressionListQuery) {}

export const AddedSuppression = Suppression.extend({
  created: z.boolean().describe('False when the chat was already on the list; nothing changed')
})
export class AddedSuppressionDto extends createZodDto(AddedSuppression) {}

// A WhatsApp id, which is never the broadcast list
const chatId = z
  .string()
  .max(MAX_CHAT_ID_LENGTH)
  .refine(value => value.trim() !== 'status@broadcast', { message: 'not a chat' })

export const AddSuppressionBody = z.strictObject({
  chatId: chatId
    .refine(value => isWaId(value) || phoneDigits(value) !== null, {
      message: 'must be a WhatsApp id or a phone number of 7 to 15 digits'
    })
    .describe(
      'The chat to stop sending to: a WhatsApp id, or a phone number that the gateway turns into the id the sends use'
    ),
  note: z.string().trim().min(1).max(200).optional().describe('Why; kept with the entry')
})
export class AddSuppressionBodyDto extends createZodDto(AddSuppressionBody) {}

export const SuppressionParams = z.strictObject({
  sessionId: SessionId,
  chatId: chatId
    .refine(value => isWaId(value), { message: 'must be a WhatsApp id' })
    .describe('A WhatsApp id such as 5215500000001@c.us')
})
export class SuppressionParamsDto extends createZodDto(SuppressionParams) {}

export const UnreachableChats = z.strictObject({
  items: z.array(z.strictObject({ chatId: z.string() })),
  truncated: z.boolean().describe('There are more flagged chats than were listed')
})
export class UnreachableChatsDto extends createZodDto(UnreachableChats) {}
