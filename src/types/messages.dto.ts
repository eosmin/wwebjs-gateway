import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { ErrorCode } from '../common/errors.js'
import { isWaId } from '../common/lib/wa-id.js'

import {
  BusinessContactDto,
  ContactDto,
  GroupChatDto,
  MessageDto,
  MessageInfoDto,
  OrderDto,
  PaymentDto,
  ReactionListDto
} from './dto.js'
import { SessionId } from './sessions.dto.js'

// ---- Params and queries ------------------------------------------------------------------------

const MessageId = z
  .string()
  .min(1)
  .max(256)
  .describe('Serialized id of the message, such as false_5215500000001@c.us_3EB0C767D0F2A2B91F42')

export const SessionMessageParams = z.strictObject({ sessionId: SessionId, messageId: MessageId })
export class SessionMessageParamsDto extends createZodDto(SessionMessageParams) {}

export const SessionJobParams = z.strictObject({
  sessionId: SessionId,
  jobId: z.string().min(1).max(128)
})
export class SessionJobParamsDto extends createZodDto(SessionJobParams) {}

export const SendQuery = z.strictObject({
  wait: z
    .stringbool()
    .default(true)
    .describe(
      'Wait for the outcome (up to SEND_SYNC_TIMEOUT_MS) and answer 201 with the message; false answers 202 with the job at once'
    )
})
export class SendQueryDto extends createZodDto(SendQuery) {}

export const SearchMessagesQuery = z.strictObject({
  query: z.string().trim().min(1).max(200).describe('Text to look for'),
  chatId: z.string().min(1).max(100).optional().describe('Search only this chat'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1)
})
export class SearchMessagesQueryDto extends createZodDto(SearchMessagesQuery) {}

export const StoredMessagesQuery = z.strictObject({
  chatId: z.string().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional().describe('The `nextCursor` of the previous page'),
  limit: z.coerce.number().int().min(1).max(200).default(50)
})
export class StoredMessagesQueryDto extends createZodDto(StoredMessagesQuery) {}

export const DeleteMessageQuery = z.strictObject({
  everyone: z.stringbool().default(false).describe('Delete it for everyone in the chat'),
  clearMedia: z.stringbool().default(false).describe('Also delete the downloaded media')
})
export class DeleteMessageQueryDto extends createZodDto(DeleteMessageQuery) {}

// ---- Send body ---------------------------------------------------------------------------------

const Recipient = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe(
    'A phone number (spaces, dashes and a leading + are fine) or a WhatsApp id (`@c.us`, `@g.us`, `@lid`, `@newsletter`, `status@broadcast`)'
  )

const WaIdList = z
  .array(z.string().refine(isWaId, 'Not a WhatsApp id'))
  .max(256)
  .describe('WhatsApp ids')

export const Humanize = z.strictObject({
  enabled: z
    .boolean()
    .optional()
    .describe('false sends without typing, even when the session humanizes its texts by default'),
  typing: z
    .union([z.literal('auto'), z.number().int().min(0).max(60_000)])
    .optional()
    .describe(
      'Show "typing" before sending: `auto` sizes it from the text, a number is milliseconds'
    ),
  recording: z.boolean().optional().describe('Show "recording audio" instead of "typing"'),
  markSeenFirst: z.boolean().optional().describe('Mark the chat as read before the pause'),
  minReplyDelayMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe('Shortest typing pause; defaults to HUMANIZE_MIN_REPLY_DELAY_MS')
})

const commonShape = {
  ignoreQuoteErrors: z.boolean().optional(),
  mentions: WaIdList.optional(),
  groupMentions: z
    .array(z.strictObject({ subject: z.string().max(200), id: z.string().min(1).max(100) }))
    .max(32)
    .optional(),
  linkPreview: z.boolean().optional(),
  parseVCards: z.boolean().optional(),
  sendSeen: z.boolean().optional(),
  waitUntilMsgSent: z.boolean().optional(),
  humanize: Humanize.optional()
}

// Zod leaves out the optional keys a request did not send, so `in` tells what was sent
const hasExactlyOneContactSource = (contact: object): boolean =>
  'contactId' in contact !== 'vcard' in contact

// type/subtype with the characters of RFC 6838: it ends up in a header and in the message
const MimeType = z
  .string()
  .max(127)
  .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/, 'Not a media type such as image/png')

const MediaSource = z.union([
  z.strictObject({
    base64: z.string().min(1),
    mimetype: MimeType,
    filename: z.string().max(255).optional()
  }),
  z.strictObject({
    url: z.url().max(2048),
    filename: z.string().max(255).optional()
  }),
  z.strictObject({ messageId: MessageId })
])

export type MediaSource = z.infer<typeof MediaSource>

// What defines a scheduled event, for sending one and for editing one
export const EventFields = {
  name: z.string().min(1).max(255),
  startTime: z.iso.datetime(),
  endTime: z.iso.datetime().optional(),
  description: z.string().max(2048).optional(),
  location: z.string().max(255).optional(),
  // Sending a call link needs a WhatsApp Web module that no longer exists: voice and video are refused
  callType: z
    .never({ error: 'callType is not accepted: call links are not supported by WhatsApp Web' })
    .optional()
}

// The content variants, shared by the send and the reply bodies; `extra` is what differs between them
function variants<E extends z.ZodRawShape>(extra: E) {
  const base = { ...commonShape, ...extra }
  return z.discriminatedUnion('type', [
    z.strictObject({ ...base, type: z.literal('text'), body: z.string().min(1).max(65_536) }),
    z.strictObject({
      ...base,
      type: z.literal('media'),
      source: MediaSource.describe(
        'Inline `base64`, a public `url` (fetched by the gateway), or the `messageId` of a message whose media is sent again'
      ),
      caption: z.string().max(4096).optional(),
      asDocument: z.boolean().optional(),
      asVoice: z.boolean().optional(),
      asGif: z.boolean().optional(),
      asSticker: z.boolean().optional(),
      stickerName: z.string().max(100).optional(),
      stickerAuthor: z.string().max(100).optional(),
      stickerCategories: z.array(z.string().max(16)).max(3).optional(),
      asHd: z.boolean().optional(),
      viewOnce: z.boolean().optional()
    }),
    z.strictObject({
      ...base,
      type: z.literal('location'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().max(200).optional(),
      address: z.string().max(500).optional(),
      url: z.url().max(2048).optional()
    }),
    z
      .strictObject({
        ...base,
        type: z.literal('contact'),
        contactId: z.string().refine(isWaId, 'Not a WhatsApp id').optional(),
        vcard: z.string().min(1).max(65_536).optional()
      })
      .refine(hasExactlyOneContactSource, {
        path: ['contactId'],
        message: 'Send either contactId or vcard'
      }),
    z.strictObject({
      ...base,
      type: z.literal('contacts'),
      contactIds: z.array(z.string().refine(isWaId, 'Not a WhatsApp id')).min(1).max(20)
    }),
    z.strictObject({
      ...base,
      type: z.literal('poll'),
      name: z.string().min(1).max(255),
      options: z.array(z.string().min(1).max(100)).min(2).max(12),
      allowMultipleAnswers: z.boolean().optional()
    }),
    z.strictObject({
      ...base,
      type: z.literal('event'),
      ...EventFields
    }),
    z.strictObject({
      ...base,
      type: z.literal('groupInvite'),
      inviteCode: z
        .string()
        .regex(/^[\w-]{10,64}$/)
        .describe('The code of the invite link, the part after chat.whatsapp.com/')
    })
  ])
}

export const SendMessageBody = variants({
  to: Recipient,
  quotedMessageId: MessageId.optional().describe('Send as a reply to this message')
})
export type SendMessageBody = z.infer<typeof SendMessageBody>

export const ReplyMessageBody = variants({
  to: Recipient.optional().describe('The chat to reply in; by default the chat of the message')
})
export type ReplyMessageBody = z.infer<typeof ReplyMessageBody>

// ---- Action bodies -----------------------------------------------------------------------------

export const ReactBody = z.strictObject({
  reaction: z.string().max(32).describe('An emoji; an empty string removes the reaction')
})
export class ReactBodyDto extends createZodDto(ReactBody) {}

export const ForwardBody = z.strictObject({ chatId: Recipient })
export class ForwardBodyDto extends createZodDto(ForwardBody) {}

export const PIN_DURATIONS = [86_400, 604_800, 2_592_000] as const
export const PinBody = z.strictObject({
  duration: z
    .union(
      PIN_DURATIONS.map(seconds => z.literal(seconds)) as [
        z.ZodLiteral<86_400>,
        z.ZodLiteral<604_800>,
        z.ZodLiteral<2_592_000>
      ]
    )
    .describe('Seconds the message stays pinned: 1 day, 7 days or 30 days')
})
export class PinBodyDto extends createZodDto(PinBody) {}

export const EditMessageBody = z.strictObject({
  body: z.string().min(1).max(65_536),
  linkPreview: z.boolean().optional(),
  mentions: WaIdList.optional()
})
export class EditMessageBodyDto extends createZodDto(EditMessageBody) {}

// ---- Responses ---------------------------------------------------------------------------------

// The DTO schemas carry an id in their meta; a copy without it keeps the class name nestjs-zod gives
// each response in the OpenAPI document from clashing with it
const plain = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => z.object(schema.shape)

// The message inside other responses is the copy too: the same schema under its own id in several
// DTOs makes nestjs-zod see two different definitions of `MessageDto`
const Message = plain(MessageDto)

export class MessageResponseDto extends createZodDto(Message) {}
export class MessageInfoResponseDto extends createZodDto(plain(MessageInfoDto)) {}
export class OrderResponseDto extends createZodDto(plain(OrderDto)) {}
export class PaymentResponseDto extends createZodDto(plain(PaymentDto)) {}

export class MessageListDto extends createZodDto(z.object({ items: z.array(Message) })) {}
export class StoredMessagesDto extends createZodDto(
  z.object({
    items: z.array(Message),
    nextCursor: z.string().nullable().describe('Null on the last page')
  })
) {}
export class ReactionsDto extends createZodDto(z.object({ items: z.array(ReactionListDto) })) {}
export class MessageContactsDto extends createZodDto(
  z.object({ items: z.array(z.union([BusinessContactDto, ContactDto])) })
) {}
export class MessageGroupsDto extends createZodDto(z.object({ items: z.array(GroupChatDto) })) {}

const SendError = z.object({
  code: z.enum(ErrorCode),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional()
})

// A send as the API reports it: right after a synchronous send, and when the job is read later.
// `message` comes with `sent`, `error` with `failed`.
export const SendJob = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'active', 'sent', 'failed']),
  message: Message.optional(),
  error: SendError.optional()
})
export class SendJobDto extends createZodDto(SendJob) {}

export const IdempotencyKeyHeader = z
  .string()
  .min(1)
  .max(128)
  .describe('Same key and same request: the first result again; same key, another request: 422')
