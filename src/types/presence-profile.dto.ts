import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { MediaSource } from './messages.dto.js'

// The limits WhatsApp itself applies to the "about" text and to the profile name
export const MAX_ABOUT_LENGTH = 139
export const MAX_DISPLAY_NAME_LENGTH = 25

export const SetPresenceBody = z.strictObject({
  state: z
    .enum(['available', 'unavailable'])
    .describe(
      '`available` shows the account as online; `unavailable` as offline, and the linked phone gets its notifications again'
    )
})
export class SetPresenceBodyDto extends createZodDto(SetPresenceBody) {}

export const SetProfileStatusBody = z.strictObject({
  status: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ABOUT_LENGTH)
    .describe(`The "about" text of the profile, up to ${MAX_ABOUT_LENGTH} characters`)
})
export class SetProfileStatusBodyDto extends createZodDto(SetProfileStatusBody) {}

export const SetDisplayNameBody = z.strictObject({
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(MAX_DISPLAY_NAME_LENGTH)
    .describe(`The name of the profile, up to ${MAX_DISPLAY_NAME_LENGTH} characters`)
})
export class SetDisplayNameBodyDto extends createZodDto(SetDisplayNameBody) {}

export const SetProfilePictureBody = z.strictObject({
  source: MediaSource.describe(
    'An image: inline `base64` (the body of a request is limited to 1 MiB), a public `url` (fetched by the gateway), or the `messageId` of a message whose image is used'
  )
})
export class SetProfilePictureBodyDto extends createZodDto(SetProfilePictureBody) {}

export const SetAccountSettingsBody = z
  .strictObject({
    autoDownloadAudio: z.boolean().optional(),
    autoDownloadDocuments: z.boolean().optional(),
    autoDownloadPhotos: z.boolean().optional(),
    autoDownloadVideos: z.boolean().optional(),
    backgroundSync: z.boolean().optional()
  })
  .refine(body => Object.keys(body).length > 0, {
    message: 'send at least one setting'
  })
export type SetAccountSettingsBody = z.infer<typeof SetAccountSettingsBody>
export class SetAccountSettingsBodyDto extends createZodDto(SetAccountSettingsBody) {}
