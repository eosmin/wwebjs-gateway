import { Inject, Injectable } from '@nestjs/common'

import { isForeignKeyViolation, nullIfMissing } from '../db-errors.js'
import type { Webhook, WebhookMediaMode } from '../models.js'
import { PrismaService } from '../prisma.service.js'

export interface NewWebhook {
  // Null = every session
  sessionId?: string | null
  url: string
  secret: string
  events?: string[]
  enabled?: boolean
  mediaMode?: WebhookMediaMode
  // Null = follow INCLUDE_RAW
  includeRaw?: boolean | null
}

export interface WebhookPatch {
  url?: string
  secret?: string
  events?: string[]
  enabled?: boolean
  mediaMode?: WebhookMediaMode
  includeRaw?: boolean | null
}

@Injectable()
export class WebhooksRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // Null when the session of the webhook does not exist (any more)
  async create(data: NewWebhook): Promise<Webhook | null> {
    try {
      return await this.prisma.webhook.create({ data })
    } catch (error) {
      if (isForeignKeyViolation(error)) return null
      throw error
    }
  }

  findById(id: string): Promise<Webhook | null> {
    return this.prisma.webhook.findUnique({ where: { id } })
  }

  // Every webhook, or only those of one session
  list(sessionId?: string): Promise<Webhook[]> {
    return this.prisma.webhook.findMany({
      where: sessionId === undefined ? {} : { sessionId },
      orderBy: { createdAt: 'desc' }
    })
  }

  // How many webhooks a session has, the disabled ones too (null = those of every session)
  countFor(sessionId: string | null): Promise<number> {
    return this.prisma.webhook.count({ where: { sessionId } })
  }

  // The enabled webhooks that receive the events of a session: its own and those of every session
  listEnabledFor(sessionId: string): Promise<Webhook[]> {
    return this.prisma.webhook.findMany({
      where: { enabled: true, OR: [{ sessionId }, { sessionId: null }] },
      orderBy: { createdAt: 'asc' }
    })
  }

  update(id: string, patch: WebhookPatch): Promise<Webhook | null> {
    return nullIfMissing(this.prisma.webhook.update({ where: { id }, data: patch }))
  }

  // Cascades to its deliveries; false when it did not exist
  async delete(id: string): Promise<boolean> {
    const { count } = await this.prisma.webhook.deleteMany({ where: { id } })
    return count > 0
  }
}
