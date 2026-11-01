import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { ChatId } from './chats.dto.js'
import { LabelDto } from './dto.js'
import { SessionId } from './sessions.dto.js'

// One call changes this many chats or labels at most: WhatsApp Web applies them in one go, and the
// gateway checks each chat on the page first
export const MAX_LABELS_PER_CALL = 50
export const MAX_CHATS_PER_CALL = 100

const LabelId = z
  .string()
  .trim()
  .regex(/^[\w.-]{1,32}$/, 'must be the id of a label, such as 1')
  .describe('Id of the label, as `labels.list` gives it')

const unique = (ids: string[]): boolean => new Set(ids).size === ids.length

// ---- Params ------------------------------------------------------------------------------------

export const SessionLabelParams = z.strictObject({ sessionId: SessionId, labelId: LabelId })
export class SessionLabelParamsDto extends createZodDto(SessionLabelParams) {}

// ---- Bodies ------------------------------------------------------------------------------------

const LabelIds = z
  .array(LabelId)
  .max(MAX_LABELS_PER_CALL)
  .refine(unique, { message: 'repeats a label' })

// WhatsApp Web sets the labels of a chat: the ones listed are added and any other the chat has is
// removed, so the list is the whole set and an empty one clears the chat
export const SetChatLabelsBody = z.strictObject({
  labelIds: LabelIds.describe('The labels the chat ends with; an empty list removes them all')
})
export class SetChatLabelsBodyDto extends createZodDto(SetChatLabelsBody) {}

export const AssignLabelsBody = z.strictObject({
  labelIds: LabelIds.describe(
    'The labels every chat in `chatIds` ends with; an empty list removes them all'
  ),
  chatIds: z
    .array(ChatId)
    .min(1)
    .max(MAX_CHATS_PER_CALL)
    .refine(unique, { message: 'repeats a chat' })
    .describe('The chats whose labels are set')
})
export class AssignLabelsBodyDto extends createZodDto(AssignLabelsBody) {}

// ---- Responses ---------------------------------------------------------------------------------

// The DTO schema carries an id in its meta: a copy without it keeps nestjs-zod from seeing two
// definitions of the same id once the schema sits inside several responses (see messages.dto.ts)
const Label = z.object(LabelDto.shape)

export class LabelResponseDto extends createZodDto(Label) {}
export class LabelListDto extends createZodDto(z.object({ items: z.array(Label) })) {}
