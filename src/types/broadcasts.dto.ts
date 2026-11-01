import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { ContactId } from './contacts.dto.js'
import { BroadcastDto, MessageDto } from './dto.js'
import { SessionId } from './sessions.dto.js'

// The broadcast of a user is keyed by the user's id, the same one `contacts.get` takes
export const SessionBroadcastParams = z.strictObject({
  sessionId: SessionId,
  broadcastId: ContactId.describe(
    'Id of the user whose statuses are read, such as 5215500000001@c.us; the account itself reads its own'
  )
})
export class SessionBroadcastParamsDto extends createZodDto(SessionBroadcastParams) {}

// The DTO schemas carry an id in their meta: copies without it keep nestjs-zod from seeing two
// definitions of the same id once the schema sits inside several responses (see messages.dto.ts)
const Broadcast = z.object({
  ...BroadcastDto.shape,
  msgs: z.array(z.object(MessageDto.shape))
})

export class BroadcastResponseDto extends createZodDto(Broadcast) {}
export class BroadcastListDto extends createZodDto(z.object({ items: z.array(Broadcast) })) {}
