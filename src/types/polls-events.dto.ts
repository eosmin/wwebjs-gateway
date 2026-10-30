import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { PollVoteDto } from './dto.js'
import { EventFields } from './messages.dto.js'

export const VoteBody = z.strictObject({
  selectedOptions: z
    .array(z.string().min(1).max(100))
    .max(12)
    .describe('The names of the options to vote for; an empty list removes the vote')
})
export class VoteBodyDto extends createZodDto(VoteBody) {}

export const EventResponseBody = z.strictObject({
  response: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .describe('0 removes a previous response, 1 going, 2 not going, 3 maybe')
})
export class EventResponseBodyDto extends createZodDto(EventResponseBody) {}

// An edit sends the whole event again: WhatsApp rebuilds it from the fields, so one left out is cleared
export const EditEventBody = z.strictObject({
  ...EventFields,
  isEventCanceled: z.boolean().optional().describe('Cancels the event')
})
export type EditEventBody = z.infer<typeof EditEventBody>
export class EditEventBodyDto extends createZodDto(EditEventBody) {}

// A copy of the DTO without its id in the meta, as the other responses do (see messages.dto.ts)
export class PollVotesDto extends createZodDto(
  z.object({ items: z.array(z.object(PollVoteDto.shape)) })
) {}

export class GroupInviteResultDto extends createZodDto(
  z.object({ status: z.number().int().describe('The status code WhatsApp answers with') })
) {}
