import { Inject, Injectable } from '@nestjs/common'

import type { DeliveryStatus, JsonInput, WebhookDelivery } from '../models.js'
import { PrismaService } from '../prisma.service.js'

export interface NewDelivery {
  webhookId: string
  sessionId: string
  event: string
  // bigint because the column is: the service converts at the DTO boundary
  seq: bigint
  payload: JsonInput
}

// What one attempt to deliver came to. `pending` is a failed attempt that will be retried.
export interface DeliveryAttempt {
  status: DeliveryStatus
  statusCode?: number | null
  error?: string | null
}

// Deliveries created in the same millisecond are told apart by id
export interface DeliveryCursor {
  createdAt: Date
  id: string
}

export interface DeliveryFilter {
  status?: DeliveryStatus
  limit: number
  // Continue after the last delivery of the previous page
  before?: DeliveryCursor
}

@Injectable()
export class DeliveriesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  create(data: NewDelivery): Promise<WebhookDelivery> {
    return this.prisma.webhookDelivery.create({ data })
  }

  findById(id: string): Promise<WebhookDelivery | null> {
    return this.prisma.webhookDelivery.findUnique({ where: { id } })
  }

  listForWebhook(webhookId: string, filter: DeliveryFilter): Promise<WebhookDelivery[]> {
    return this.prisma.webhookDelivery.findMany({
      where: {
        webhookId,
        status: filter.status,
        OR: filter.before && [
          { createdAt: { lt: filter.before.createdAt } },
          { createdAt: filter.before.createdAt, id: { lt: filter.before.id } }
        ]
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit
    })
  }

  // A delivered row is final: a late result of an earlier attempt must not undo it. Null when the
  // delivery does not exist or is already delivered.
  async recordAttempt(
    id: string,
    attempt: DeliveryAttempt,
    at: Date
  ): Promise<WebhookDelivery | null> {
    const { count } = await this.prisma.webhookDelivery.updateMany({
      where: { id, status: { not: 'success' } },
      data: {
        status: attempt.status,
        attempts: { increment: 1 },
        lastStatusCode: attempt.statusCode ?? null,
        lastError: attempt.error ?? null,
        deliveredAt: attempt.status === 'success' ? at : undefined
      }
    })
    return count === 0 ? null : this.findById(id)
  }

  // A manual retry of a dead letter: back to pending, the attempts already made stay counted. Null
  // when the delivery does not exist or is not failed, so a delivered one is never sent twice.
  async resetForRetry(id: string): Promise<WebhookDelivery | null> {
    const { count } = await this.prisma.webhookDelivery.updateMany({
      where: { id, status: 'failed' },
      data: { status: 'pending' }
    })
    return count === 0 ? null : this.findById(id)
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.webhookDelivery.deleteMany({
      where: { createdAt: { lt: cutoff } }
    })
    return count
  }
}
