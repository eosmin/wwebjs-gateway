import { z } from 'zod'

import { type ErrorCode } from '../common/errors.js'
import { WA_EVENT_NAMES } from '../types/events.js'
import { SessionId } from '../types/sessions.dto.js'

// The event the server sends to a client: the envelope of TDD §5.5
export const SOCKET_EVENT = 'wa:event'
// The `subscribe` target of an admin key: every session
export const ALL_SESSIONS = '*'

export const REPLAY_DEFAULT_LIMIT = 500
export const REPLAY_MAX_LIMIT = 1000
// Sessions one socket may follow at once; the bound on what one client makes the gateway keep
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 64
// Commands one socket may have running at once; a client that wants more waits for its acks
export const MAX_COMMANDS_IN_FLIGHT = 32
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128

const EventSelector = z.union([z.enum(WA_EVENT_NAMES), z.literal('*')])

export const SubscribeMessage = z.strictObject({
  sessionId: z.union([SessionId, z.literal(ALL_SESSIONS)]),
  // Absent or containing `*`: every event but the credential ones (`qr`, `code`), which are sent
  // only when named, and only to a key with the `manage` scope
  events: z
    .array(EventSelector)
    .min(1)
    .max(WA_EVENT_NAMES.length + 1)
    .optional()
})
export type SubscribeMessage = z.infer<typeof SubscribeMessage>

export const UnsubscribeMessage = z.strictObject({
  sessionId: z.union([SessionId, z.literal(ALL_SESSIONS)])
})

export const CommandMessage = z.strictObject({
  op: z.string().min(1).max(100),
  sessionId: SessionId.optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).optional()
})
export type CommandMessage = z.infer<typeof CommandMessage>

export const ReplayMessage = z.strictObject({
  sessionId: SessionId,
  afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(REPLAY_MAX_LIMIT).default(REPLAY_DEFAULT_LIMIT)
})

export interface SocketErrorBody {
  code: ErrorCode
  message: string
  details?: Readonly<Record<string, unknown>>
}

export type SocketFailure = { ok: false; error: SocketErrorBody }

export interface SubscribeSnapshot {
  status: string
  // Only for a key with `manage`, and only while the session waits for a scan
  qr?: string
  // The last `seq` the session has handed out: events with a higher one are not in the snapshot
  seq: number
}

export type SubscribeAck = { ok: true; snapshot: SubscribeSnapshot | null } | SocketFailure
export type UnsubscribeAck = { ok: true } | SocketFailure
export type CommandAck = { ok: true; data: unknown } | SocketFailure
export type ReplayAck =
  | {
      ok: true
      // First and last `seq` read, or null when nothing was kept after `afterSeq`
      from: number | null
      to: number | null
      truncated: boolean
    }
  | SocketFailure
