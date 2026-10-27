import type { Prisma } from '../generated/prisma/client.js'

// The rows the repositories hand out. Code outside src/database/** imports them from here, never
// from the generated client, so the persistence layer stays behind the repositories.
export type {
  ApiKey,
  IdempotencyKey,
  InboundHook,
  Session,
  StoredMessage,
  Suppression,
  Webhook,
  WebhookDelivery
} from '../generated/prisma/client.js'
export type {
  DeliveryStatus,
  IdempotencyStatus,
  MessageDirection,
  SuppressionReason,
  WebhookMediaMode
} from '../generated/prisma/enums.js'

// What a Json column accepts when written
export type JsonInput = Prisma.InputJsonValue
