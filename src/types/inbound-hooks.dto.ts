import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { SessionId } from './sessions.dto.js'

const isoDate = z.iso.datetime()

export const InboundHookParams = z.strictObject({
  sessionId: SessionId,
  hookId: z.uuid().describe('Id of the inbound hook')
})
export class InboundHookParamsDto extends createZodDto(InboundHookParams) {}

export const CreateInboundHookBody = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('Label that tells the hook apart from the others of the session')
})
export class CreateInboundHookDto extends createZodDto(CreateInboundHookBody) {}

const hookShape = {
  id: z.uuid(),
  sessionId: z.string(),
  name: z.string(),
  createdAt: isoDate,
  revokedAt: isoDate.nullable().describe('Set once the hook is revoked; it then answers 401')
}

export const InboundHook = z.object(hookShape)
export class InboundHookDto extends createZodDto(InboundHook) {}

export const InboundHookList = z.object({ hooks: z.array(InboundHook) })
export class InboundHookListDto extends createZodDto(InboundHookList) {}

export const CreatedInboundHook = z.object({
  ...hookShape,
  url: z
    .string()
    .describe('The URL to POST to. It holds the token, which is shown here and never again')
})
export class CreatedInboundHookDto extends createZodDto(CreatedInboundHook) {}
