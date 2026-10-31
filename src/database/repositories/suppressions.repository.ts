import { Inject, Injectable } from '@nestjs/common'

import type { Suppression, SuppressionReason } from '../models.js'
import { PrismaService } from '../prisma.service.js'

export interface NewSuppression {
  sessionId: string
  chatId: string
  reason: SuppressionReason
  note?: string | null
}

export interface AddSuppressionResult {
  // False when the chat was already on the list (its reason and note are kept)
  created: boolean
  suppression: Suppression
}

@Injectable()
export class SuppressionsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // The caller publishes `chat_suppressed` only for a chat that was not on the list yet
  async add(data: NewSuppression): Promise<AddSuppressionResult> {
    const { count } = await this.prisma.suppression.createMany({
      data: [data],
      skipDuplicates: true
    })
    const suppression = await this.prisma.suppression.findUniqueOrThrow({
      where: { sessionId_chatId: { sessionId: data.sessionId, chatId: data.chatId } }
    })
    return { created: count === 1, suppression }
  }

  // False when the chat was not on the list
  async remove(sessionId: string, chatId: string): Promise<boolean> {
    const { count } = await this.prisma.suppression.deleteMany({ where: { sessionId, chatId } })
    return count > 0
  }

  // Asked before every send
  async isSuppressed(sessionId: string, chatId: string): Promise<boolean> {
    const found = await this.prisma.suppression.findUnique({
      where: { sessionId_chatId: { sessionId, chatId } },
      select: { chatId: true }
    })
    return found !== null
  }

  // Every list of every session, for the gauge
  countAll(): Promise<number> {
    return this.prisma.suppression.count()
  }

  countOf(sessionId: string): Promise<number> {
    return this.prisma.suppression.count({ where: { sessionId } })
  }

  list(sessionId: string): Promise<Suppression[]> {
    return this.prisma.suppression.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' }
    })
  }
}
