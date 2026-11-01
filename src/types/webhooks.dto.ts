import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { WA_EVENT_NAMES } from './events.js'

const isoDate = z.iso.datetime()

// A webhook listens to a handful of events; the bound keeps one request from storing a huge row
const MAX_EVENT_FILTERS = WA_EVENT_NAMES.length + 1

const mediaMode = z
  .enum(['none', 'reference', 'inline'])
  .describe(
    'How media travels: none = metadata only, reference = a download URL, inline = base64 within WEBHOOK_INLINE_MEDIA_MAX_BYTES'
  )

const events = z
  .array(z.enum(['*', ...WA_EVENT_NAMES]))
  .min(1)
  .max(MAX_EVENT_FILTERS)
  .describe('Events delivered; "*" is every event')

const includeRaw = z
  .boolean()
  .describe('Whether message events carry the sanitized raw data; null follows INCLUDE_RAW')

const url = z
  .url()
  .max(2048)
  .describe('Where the events are POSTed; http or https on a public host')

export const WebhookIdParams = z.strictObject({ id: z.uuid().describe('Id of the webhook') })
export class WebhookIdParamsDto extends createZodDto(WebhookIdParams) {}

export const CreateWebhookBody = z.strictObject({
  url,
  sessionId: z
    .string()
    .regex(/^[-_\w]{1,64}$/)
    .optional()
    .describe('Session whose events are delivered; omit it for the events of every session'),
  events: events.optional().describe('Events delivered; defaults to every event'),
  enabled: z.boolean().optional().describe('Defaults to true'),
  mediaMode: mediaMode.optional().describe('Defaults to reference'),
  includeRaw: includeRaw.nullable().optional()
})
export class CreateWebhookDto extends createZodDto(CreateWebhookBody) {}

// The session of a webhook never changes: delete it and create another
export const UpdateWebhookBody = z
  .strictObject({
    url: url.optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
    mediaMode: mediaMode.optional(),
    includeRaw: includeRaw.nullable().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'Send at least one field to change'
  })
export class UpdateWebhookDto extends createZodDto(UpdateWebhookBody) {}

const webhookShape = {
  id: z.uuid(),
  sessionId: z.string().nullable().describe('Null = the events of every session'),
  url: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  mediaMode,
  includeRaw: includeRaw.nullable(),
  createdAt: isoDate
}

export const Webhook = z.object(webhookShape)
export class WebhookDto extends createZodDto(Webhook) {}

export const WebhookList = z.object({ webhooks: z.array(Webhook) })
export class WebhookListDto extends createZodDto(WebhookList) {}

export const CreatedWebhook = z.object({
  ...webhookShape,
  secret: z.string().describe('Signs the deliveries; shown here and on rotation, never again')
})
export class CreatedWebhookDto extends createZodDto(CreatedWebhook) {}
