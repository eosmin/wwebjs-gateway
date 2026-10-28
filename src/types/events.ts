import { z } from 'zod'

import { ErrorCode } from '../common/errors.js'

import {
  BatteryInfoDto,
  CallDto,
  ChatDto,
  GroupNotificationDto,
  MessageDto,
  OriginDto,
  PollVoteDto,
  ReactionDto,
  SessionStatus
} from './dto.js'

// The 31 events whatsapp-web.js emits (Constants.js of 1.34.7), then the ones the gateway makes up
export const WA_EVENT_NAMES = [
  'qr',
  'code',
  'authenticated',
  'auth_failure',
  'ready',
  'loading_screen',
  'disconnected',
  'change_state',
  'change_battery',
  'message',
  'message_create',
  'message_ack',
  'message_edit',
  'message_revoke_everyone',
  'message_revoke_me',
  'message_reaction',
  'message_ciphertext',
  'message_ciphertext_failed',
  'media_uploaded',
  'unread_count',
  'chat_removed',
  'chat_archived',
  'contact_changed',
  'group_join',
  'group_leave',
  'group_update',
  'group_admin_changed',
  'group_membership_request',
  'vote_update',
  'call',
  'remote_session_saved',
  'session_status',
  'message_batch',
  'message_sent',
  'message_failed',
  'session_error',
  'chat_suppressed',
  'chat_unreachable',
  'ping'
] as const

export type WaEventName = (typeof WA_EVENT_NAMES)[number]

const none = z.object({})

const errorBody = z.object({
  code: z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional()
})

interface EventDefinition {
  fires: string
  payload: z.ZodType
}

// The single source for webhooks, Socket.IO and docs/events.md. `payload` is the `data` of the
// envelope: always a DTO, never a raw wwebjs object.
export const WA_EVENTS = {
  qr: {
    fires:
      'WhatsApp Web shows a QR code to scan. A new one arrives every few seconds until the session is paired.',
    payload: z.object({ qr: z.string().describe('The text to render as a QR code') })
  },
  code: {
    fires: 'The pairing code of a phone-number login is ready.',
    payload: z.object({ code: z.string() })
  },
  authenticated: {
    fires: 'Authentication succeeded; the session is about to become ready.',
    payload: none
  },
  auth_failure: {
    fires: 'Restoring a saved session failed; the session needs a new QR code.',
    payload: z.object({ message: z.string() })
  },
  ready: {
    fires: 'The session finished loading and can send and receive.',
    payload: none
  },
  loading_screen: {
    fires: 'WhatsApp Web reports its loading progress.',
    payload: z.object({ percent: z.string(), message: z.string() })
  },
  disconnected: {
    fires: 'The session lost its connection to WhatsApp, or the account logged out.',
    payload: z.object({ reason: z.string().describe('A WhatsApp state, or LOGOUT') })
  },
  change_state: {
    fires: 'The connection state of WhatsApp Web changed.',
    payload: z.object({ state: z.string().describe('A WhatsApp state, such as CONNECTED') })
  },
  change_battery: {
    fires: 'The battery of the linked phone changed. Deprecated by wwebjs.',
    payload: BatteryInfoDto
  },
  message: {
    fires: 'A message arrived. Messages the session sends itself arrive as message_create.',
    payload: MessageDto
  },
  message_create: {
    fires: 'A message was created, including the ones the session itself sends.',
    payload: MessageDto
  },
  message_ack: {
    fires: 'The delivery status of a message changed.',
    payload: z.object({
      message: MessageDto,
      ack: z.number().int().describe('-1 error, 0 pending, 1 server, 2 device, 3 read, 4 played')
    })
  },
  message_edit: {
    fires: 'A message was edited.',
    payload: z.object({ message: MessageDto, newBody: z.string(), prevBody: z.string() })
  },
  message_revoke_everyone: {
    fires: 'A message was deleted for everyone in the chat.',
    payload: z.object({
      message: MessageDto.describe('The message in its current state, without its original data'),
      revokedMessage: MessageDto.nullish().describe(
        'The message before it was deleted; absent or null when it could not be captured'
      )
    })
  },
  message_revoke_me: {
    fires: 'The session deleted a message for itself only.',
    payload: MessageDto
  },
  message_reaction: {
    fires: 'A reaction was sent, received, changed or removed.',
    payload: ReactionDto
  },
  message_ciphertext: {
    fires: 'A message arrived that is not decrypted yet.',
    payload: MessageDto
  },
  message_ciphertext_failed: {
    fires: 'A message could not be decrypted after WhatsApp retried.',
    payload: MessageDto
  },
  media_uploaded: {
    fires: 'The media of a message the session sent finished uploading.',
    payload: MessageDto
  },
  unread_count: {
    fires: 'The unread counter of a chat changed.',
    payload: ChatDto
  },
  chat_removed: {
    fires: 'A chat was removed.',
    payload: ChatDto
  },
  chat_archived: {
    fires: 'A chat was archived or unarchived.',
    payload: z.object({ chat: ChatDto, currState: z.boolean(), prevState: z.boolean() })
  },
  contact_changed: {
    fires: 'A contact or a group participant changed their phone number.',
    payload: z.object({
      message: MessageDto,
      oldId: z.string(),
      newId: z.string(),
      isContact: z.boolean()
    })
  },
  group_join: {
    fires: 'Someone joined a group by invite link or was added by an admin.',
    payload: GroupNotificationDto
  },
  group_leave: {
    fires: 'Someone left a group or was removed by an admin.',
    payload: GroupNotificationDto
  },
  group_update: {
    fires: 'The subject, description or picture of a group changed.',
    payload: GroupNotificationDto
  },
  group_admin_changed: {
    fires: 'The session was promoted to admin of a group or demoted.',
    payload: GroupNotificationDto
  },
  group_membership_request: {
    fires: 'Someone asked to join a group that approves its members.',
    payload: GroupNotificationDto
  },
  vote_update: {
    fires: 'A poll option was selected or deselected.',
    payload: PollVoteDto
  },
  call: {
    fires: 'A call came in.',
    payload: CallDto
  },
  remote_session_saved: {
    fires:
      'A RemoteAuth session was saved to its store. The gateway does not use RemoteAuth, so this does not fire.',
    payload: none
  },
  session_status: {
    fires:
      'The session moved to another status (created, starting, qr, pairing_code, authenticating, ready, disconnected, stopped, failed).',
    payload: z.object({
      status: SessionStatus,
      previous: SessionStatus,
      reason: z.string().optional()
    })
  },
  message_batch: {
    fires:
      'A burst of messages written while the contact was offline was ordered and published. Answer once to this instead of to every message.',
    payload: z.object({
      chatId: z.string(),
      messages: z.array(MessageDto).describe('Ordered by sentAt'),
      firstSentAt: z.iso.datetime(),
      lastSentAt: z.iso.datetime(),
      count: z.number().int().min(1).describe('How many messages the batch holds'),
      origin: OriginDto.optional().describe('The first origin found among the messages'),
      reason: z.enum(['burst', 'reconcile'])
    })
  },
  message_sent: {
    fires: 'A message queued by an asynchronous send was handed to WhatsApp.',
    payload: z.object({
      jobId: z.string(),
      idempotencyKey: z.string().optional(),
      message: MessageDto
    })
  },
  message_failed: {
    fires: 'A queued message failed for good.',
    payload: z.object({
      jobId: z.string(),
      idempotencyKey: z.string().optional(),
      error: errorBody
    })
  },
  session_error: {
    fires:
      'The session hit a failure before the manager reacted: Chromium crashed, WhatsApp calls time out, or sending degraded (SEND_HEALTH_DEGRADED).',
    payload: z.object({ code: z.string(), message: z.string() })
  },
  chat_suppressed: {
    fires: 'A chat entered the suppression list of the session.',
    payload: z.object({ chatId: z.string(), reason: z.enum(['manual', 'opt_out']) })
  },
  chat_unreachable: {
    fires: 'The unreachable flag of a chat was set or cleared.',
    payload: z.object({ chatId: z.string(), unreachable: z.boolean() })
  },
  ping: {
    fires: 'A test delivery requested with POST /v1/webhooks/:id/test.',
    payload: none
  }
} as const satisfies Record<WaEventName, EventDefinition>

// What `data` holds for each event
export type WaEventPayloadMap = {
  [E in WaEventName]: z.infer<(typeof WA_EVENTS)[E]['payload']>
}

type EnvelopeSchema<E extends WaEventName> = z.ZodObject<{
  id: z.ZodString
  event: z.ZodLiteral<E>
  sessionId: z.ZodString
  seq: z.ZodNumber
  timestamp: z.ZodISODateTime
  data: (typeof WA_EVENTS)[E]['payload']
}>

// The envelope of webhooks and Socket.IO
export function eventEnvelope<E extends WaEventName>(event: E): EnvelopeSchema<E> {
  return z.object({
    id: z
      .string()
      .regex(/^evt_/)
      .describe(
        'Unique per event. A message published again after a failure or a restart gets a new id, so drop duplicates of a message by data.id too'
      )
      .meta({ examples: ['evt_0f3c9a52-7d1e-4c0b-9a55-2f1d6e8b3a10'] }),
    event: z.literal(event),
    sessionId: z
      .string()
      .regex(/^[-_\w]{1,64}$/)
      .meta({ examples: ['support-line'] }),
    seq: z.number().int().min(1).describe('Strictly increasing per session, in conversation order'),
    timestamp: z.iso.datetime(),
    data: WA_EVENTS[event].payload
  })
}

export type EventEnvelope<E extends WaEventName = WaEventName> = {
  [K in E]: {
    id: string
    event: K
    sessionId: string
    seq: number
    timestamp: string
    data: WaEventPayloadMap[K]
  }
}[E]
