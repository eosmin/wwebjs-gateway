import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { ClientInfoDto as ClientInfo, SessionStatus } from './dto.js'

const isoDate = z.iso.datetime()

export const SessionId = z
  .string()
  .regex(/^[-_\w]{1,64}$/)
  .describe('Id of the session: letters, digits, "-" and "_", up to 64 characters')

export const SessionIdParams = z.strictObject({ sessionId: SessionId })
export class SessionIdParamsDto extends createZodDto(SessionIdParams) {}

// The humanize defaults of a session (TDD §6.8): what a text message gets when the request has no
// `humanize` of its own. A request that has one replaces these as a whole.
export const HumanizeSettings = z.strictObject({
  enabled: z.boolean().optional().describe('Show typing before text messages; defaults to true'),
  typing: z
    .union([z.literal('auto'), z.number().int().min(0).max(60_000)])
    .optional()
    .describe('`auto` sizes the pause from the text; a number is milliseconds'),
  recording: z.boolean().optional(),
  markSeenFirst: z.boolean().optional(),
  minReplyDelayMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe('Shortest typing pause; defaults to HUMANIZE_MIN_REPLY_DELAY_MS')
})
export type HumanizeSettings = z.infer<typeof HumanizeSettings>

// The part of `Session.settings` that the session endpoints own. The send policy and the other
// services keep their own keys in the same column, which these endpoints never touch.
export const SessionSettingsInput = z.strictObject({
  ordering: z
    .strictObject({
      enabled: z.boolean().optional().describe('Hold and sort inbound messages for this session')
    })
    .optional(),
  humanize: HumanizeSettings.optional(),
  autoDownloadAudio: z.boolean().optional(),
  autoDownloadDocuments: z.boolean().optional(),
  autoDownloadPhotos: z.boolean().optional(),
  autoDownloadVideos: z.boolean().optional(),
  backgroundSync: z.boolean().optional()
})
export type SessionSettingsInput = z.infer<typeof SessionSettingsInput>

export const CreateSessionBody = z.strictObject({
  id: SessionId,
  name: z.string().trim().min(1).max(100).optional().describe('Label of the session'),
  autoStart: z.boolean().optional().describe('Start the session at every boot; defaults to true'),
  settings: SessionSettingsInput.optional()
})
export class CreateSessionDto extends createZodDto(CreateSessionBody) {}

export const UpdateSessionBody = z
  .strictObject({
    name: z.string().trim().min(1).max(100).nullable().optional().describe('Null clears the label'),
    autoStart: z.boolean().optional(),
    settings: SessionSettingsInput.optional().describe(
      'Keys given here replace the same keys of the session as a whole (`ordering` is replaced, not merged); the others stay as they are. A running session reads them at its next start.'
    )
  })
  .refine(body => Object.keys(body).length > 0, 'Send at least one field to change')
export class UpdateSessionDto extends createZodDto(UpdateSessionBody) {}

export const Session = z.object({
  id: SessionId,
  name: z.string().nullable(),
  status: SessionStatus,
  phoneNumber: z.string().nullable().describe('Number of the linked account'),
  pushName: z.string().nullable().describe('Name of the linked account'),
  autoStart: z.boolean(),
  settings: z.record(z.string(), z.json()),
  createdAt: isoDate,
  updatedAt: isoDate,
  lastConnectedAt: isoDate.nullable(),
  lastEventAt: isoDate.nullable(),
  linkedAt: isoDate.nullable().describe('First time the session was ready after linking'),
  lastError: z.string().nullable().describe('Why the session last failed')
})
export class SessionDto extends createZodDto(Session) {}

export const SessionList = z.object({ sessions: z.array(Session) })
export class SessionListDto extends createZodDto(SessionList) {}

export const SessionQr = z.object({
  qr: z
    .string()
    .describe('The text WhatsApp encodes in the QR code; render it with any QR library'),
  status: SessionStatus
})
export class SessionQrDto extends createZodDto(SessionQr) {}

export const SessionState = z.object({
  state: z.string().nullable().describe('Connection state WhatsApp Web reports, such as CONNECTED')
})
export class SessionStateDto extends createZodDto(SessionState) {}

export const SessionWebVersion = z.object({
  version: z.string().describe('Version of WhatsApp Web the session runs')
})
export class SessionWebVersionDto extends createZodDto(SessionWebVersion) {}

// A copy without the id `ClientInfoDto` carries in its meta: the id would clash with the name that
// nestjs-zod gives the class in the OpenAPI document
export class SessionClientInfoDto extends createZodDto(z.object(ClientInfo.shape)) {}
