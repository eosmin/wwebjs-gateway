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

export const DeliveryStatus = z
  .enum(['pending', 'success', 'failed'])
  .describe(
    'pending = waiting for an attempt or for the next retry, success = the receiver answered 2xx, failed = every attempt failed (a dead letter)'
  )

export const WebhookDeliveryParams = z.strictObject({
  id: z.uuid().describe('Id of the webhook'),
  deliveryId: z.uuid().describe('Id of the delivery')
})
export class WebhookDeliveryParamsDto extends createZodDto(WebhookDeliveryParams) {}

export const DeliveryListQuery = z.strictObject({
  status: DeliveryStatus.optional().describe('Only the deliveries in this status'),
  cursor: z.string().min(1).max(512).optional().describe('The `nextCursor` of the previous page'),
  limit: z.coerce.number().int().min(1).max(200).default(50)
})
export class DeliveryListQueryDto extends createZodDto(DeliveryListQuery) {}

// The payload stays in the gateway: it holds the event, which can be a message
export const Delivery = z.object({
  id: z.uuid(),
  webhookId: z.uuid(),
  sessionId: z.string(),
  event: z.string(),
  seq: z.number().int().describe('The `seq` of the event'),
  status: DeliveryStatus,
  attempts: z.number().int().describe('Attempts made so far; a manual retry keeps counting'),
  lastStatusCode: z.number().int().nullable().describe('HTTP status of the last attempt, if any'),
  lastError: z.string().nullable().describe('Why the last attempt failed'),
  createdAt: isoDate,
  deliveredAt: isoDate.nullable()
})
export class DeliveryDto extends createZodDto(Delivery) {}

export const DeliveryList = z.object({
  items: z.array(Delivery),
  nextCursor: z.string().nullable().describe('The `cursor` of the next page; null on the last one')
})
export class DeliveryListDto extends createZodDto(DeliveryList) {}

// No body at all is the same as an empty one: most webhooks need nothing to be tested
export const TestWebhookBody = z
  .strictObject({
    sessionId: z
      .string()
      .regex(/^[-_\w]{1,64}$/)
      .optional()
      .describe(
        'The session the ping comes from. A webhook of one session sends that session; a webhook of every session needs one'
      )
  })
  .default({})
export class TestWebhookBodyDto extends createZodDto(TestWebhookBody) {}

export const RetriedDeliveries = z.object({
  retried: z.number().int().describe('Dead letters put back in the queue by this call'),
  more: z
    .boolean()
    .describe('There are more dead letters than one call retries; call again for them')
})
export class RetriedDeliveriesDto extends createZodDto(RetriedDeliveries) {}
