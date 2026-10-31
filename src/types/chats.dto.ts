import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { ChannelDto, ChatDto, GroupChatDto, MessageDto } from './dto.js'
import { SessionId } from './sessions.dto.js'

const ChatId = z
  .string()
  .min(1)
  .max(100)
  .describe('Serialized id of the chat, such as 5215500000001@c.us or 120363000000000001@g.us')

export const SessionChatParams = z.strictObject({ sessionId: SessionId, chatId: ChatId })
export class SessionChatParamsDto extends createZodDto(SessionChatParams) {}

// Typing and recording lapse by themselves about 25 s after WhatsApp Web shows them, so a duration
// longer than that has nothing to cut short
export const MAX_STATE_DURATION_MS = 25_000

export const SetChatStateBody = z
  .strictObject({
    state: z.enum(['typing', 'recording', 'clear']).describe('`clear` stops the indicator at once'),
    durationMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_STATE_DURATION_MS)
      .optional()
      .describe(
        'Clear the indicator after this many milliseconds. Without it WhatsApp lets it lapse after about 25 s. Not kept across a restart of the gateway'
      )
  })
  .refine(body => body.state !== 'clear' || body.durationMs === undefined, {
    path: ['durationMs'],
    message: 'a clear has no duration'
  })
export type SetChatStateBody = z.infer<typeof SetChatStateBody>
export class SetChatStateBodyDto extends createZodDto(SetChatStateBody) {}

export const MuteChatBody = z.strictObject({
  until: z.iso
    .datetime()
    .optional()
    .describe('When the mute ends, in the future; without it the chat is muted for ever')
})
export class MuteChatBodyDto extends createZodDto(MuteChatBody) {}

export const ChatMessagesQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  fromMe: z.stringbool().optional().describe('Only the messages the account sent (true) or got')
})
export class ChatMessagesQueryDto extends createZodDto(ChatMessagesQuery) {}

// ---- Responses ---------------------------------------------------------------------------------

// A group has everything a chat has plus its own fields, and a channel has its own set: the order
// tries the most specific first, since an object schema strips what it does not know
// The message inside them is the copy of messages.dto.ts without its `meta.id`: two DTOs embedding
// the schema under its id make nestjs-zod see two different `MessageDto_Output` definitions
const LastMessage = z.object(MessageDto.shape).optional()
const plain = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  z.object({ ...schema.shape, lastMessage: LastMessage })
const AnyChat = z.union([plain(GroupChatDto), plain(ChannelDto), plain(ChatDto)])

// A union cannot be the base of a class, so this one is the DTO value without a class
export const ChatResponseDto = createZodDto(AnyChat)
export class ChatListDto extends createZodDto(z.object({ items: z.array(AnyChat) })) {}

export class MuteResultDto extends createZodDto(
  z.object({
    isMuted: z.boolean(),
    muteExpiration: z
      .number()
      .int()
      .describe('Unix seconds when the mute ends; -1 for ever, 0 when not muted')
  })
) {}
