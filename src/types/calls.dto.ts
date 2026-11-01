import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { SessionId } from './sessions.dto.js'

// The id wwebjs gives a call, as the `call` event delivers it
const CallId = z
  .string()
  .trim()
  .regex(/^[\w.-]{1,128}$/, 'must be the id of a call, as the `call` event gives it')
  .describe('Id of the incoming call, as the `call` event gives it')

export const SessionCallParams = z.strictObject({ sessionId: SessionId, callId: CallId })
export class SessionCallParamsDto extends createZodDto(SessionCallParams) {}

export const CALL_TYPES = ['voice', 'video'] as const

export const CreateCallLinkBody = z.strictObject({
  startTime: z.iso
    .datetime({ offset: true })
    .describe('When the call is meant to start, as an ISO 8601 date'),
  callType: z.enum(CALL_TYPES).describe('Whether the link opens a voice or a video call')
})
export class CreateCallLinkBodyDto extends createZodDto(CreateCallLinkBody) {}

export const CallLinkResponse = z.object({
  link: z.url().describe('The WhatsApp call link, such as https://call.whatsapp.com/video/XxXx')
})
export class CallLinkResponseDto extends createZodDto(CallLinkResponse) {}
