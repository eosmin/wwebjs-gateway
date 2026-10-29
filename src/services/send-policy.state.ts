import { z } from 'zod'

// The longest list the saved state may hold, so a document cannot grow without bound
export const STATE_LIST_LIMIT = 10_000
// A WhatsApp id is far shorter; the policy refuses a longer one before it reaches the state
export const MAX_CHAT_ID_LENGTH = 128

const timestamp = z.number().finite().nonnegative()
const chatId = z.string().max(MAX_CHAT_ID_LENGTH)
const bucket = z.strictObject({ tokens: z.number().finite(), at: timestamp })

// The memory of the send policy for one session (TDD §6.8.1): what the budgets have spent. It is
// plain data so it can be saved as JSON and checked when it is read back. Everything in it is
// forgotten by the rules after at most 24 hours. The chats are lists, not objects keyed by chat id:
// an id is outside data and must never become a property name.
export const PolicyState = z.strictObject({
  version: z.literal(1),
  // Session budgets; absent until the first send, which means full
  perMinute: bucket.optional(),
  perHour: bucket.optional(),
  perDay: bucket.optional(),
  // Pacing per chat, only for the chats that sent something in the last minute
  chats: z
    .array(z.strictObject({ chatId, lastAt: timestamp, perMinute: bucket }))
    .max(STATE_LIST_LIMIT),
  // Chats we wrote to first in the last 24 h, with the time of the first message
  coldChats: z.array(z.strictObject({ chatId, at: timestamp })).max(STATE_LIST_LIMIT),
  // 0 when no cold send was made yet
  lastColdAt: timestamp,
  // When each number look-up of the last 24 h was made
  lookups: z.array(timestamp).max(STATE_LIST_LIMIT),
  // What went out lately: a digest of the normalized text, never the text
  sent: z
    .array(z.strictObject({ hash: z.string().max(64), chatId, at: timestamp }))
    .max(STATE_LIST_LIMIT),
  // The latest results, true for a hard failure
  results: z.array(z.boolean()).max(STATE_LIST_LIMIT),
  // 0 when the session is not throttled
  degradedUntil: timestamp
})
export type PolicyState = z.infer<typeof PolicyState>

export function emptyPolicyState(): PolicyState {
  return {
    version: 1,
    chats: [],
    coldChats: [],
    lastColdAt: 0,
    lookups: [],
    sent: [],
    results: [],
    degradedUntil: 0
  }
}
