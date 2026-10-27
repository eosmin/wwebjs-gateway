import { Inject, Injectable } from '@nestjs/common'

import type { JsonInput, MessageDirection, StoredMessage } from '../models.js'
import { PrismaService } from '../prisma.service.js'

export interface NewStoredMessage {
  id: string
  sessionId: string
  chatId: string
  direction: MessageDirection
  fromMe: boolean
  type: string
  // Null when STORE_MESSAGE_BODIES=false
  body: string | null
  hasMedia: boolean
  ack: number
  sentAt: Date
  receivedAt: Date
  origin?: JsonInput
  dto: JsonInput
}

// sentAt has a resolution of one second, so the id breaks the ties and no message is skipped
export interface StoredMessageCursor {
  sentAt: Date
  id: string
}

export interface StoredMessageQuery {
  sessionId: string
  chatId?: string
  // Continue after the last message of the previous page
  before?: StoredMessageCursor
  limit: number
}

@Injectable()
export class MessagesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // The same message can arrive twice (wwebjs re-emits after a reconnect, reconciliation overlaps a
  // live event). The second time refreshes what can change and keeps `emittedAt` and the arrival
  // data, so a message already published is never held or reordered again.
  upsert(message: NewStoredMessage): Promise<StoredMessage> {
    const { sessionId, id, ...rest } = message
    return this.prisma.storedMessage.upsert({
      where: { sessionId_id: { sessionId, id } },
      create: { sessionId, id, ...rest },
      update: { ack: rest.ack, body: rest.body, hasMedia: rest.hasMedia, dto: rest.dto }
    })
  }

  findById(sessionId: string, id: string): Promise<StoredMessage | null> {
    return this.prisma.storedMessage.findUnique({ where: { sessionId_id: { sessionId, id } } })
  }

  // Which of these ids are already stored; the reconciliation keeps the ones that are not
  async findExistingIds(sessionId: string, ids: string[]): Promise<Set<string>> {
    const rows = await this.prisma.storedMessage.findMany({
      where: { sessionId, id: { in: ids } },
      select: { id: true }
    })
    return new Set(rows.map(row => row.id))
  }

  // False when the message is not stored
  async updateAck(sessionId: string, id: string, ack: number): Promise<boolean> {
    const { count } = await this.prisma.storedMessage.updateMany({
      where: { sessionId, id },
      data: { ack }
    })
    return count > 0
  }

  // Marks as published; a row that already has a date keeps it
  async markEmitted(sessionId: string, ids: string[], at: Date): Promise<number> {
    const { count } = await this.prisma.storedMessage.updateMany({
      where: { sessionId, id: { in: ids }, emittedAt: null },
      data: { emittedAt: at }
    })
    return count
  }

  // Incoming messages that were stored but not yet published (held when the process died), in the
  // order they were sent, to be fed again through the order buffer
  listUnemitted(sessionId: string): Promise<StoredMessage[]> {
    return this.prisma.storedMessage.findMany({
      where: { sessionId, direction: 'in', emittedAt: null },
      orderBy: [{ sentAt: 'asc' }, { receivedAt: 'asc' }]
    })
  }

  // Newest first, ties by id (the order the cursor continues from)
  listStored(query: StoredMessageQuery): Promise<StoredMessage[]> {
    return this.prisma.storedMessage.findMany({
      where: {
        sessionId: query.sessionId,
        chatId: query.chatId,
        OR: query.before && [
          { sentAt: { lt: query.before.sentAt } },
          { sentAt: query.before.sentAt, id: { lt: query.before.id } }
        ]
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: query.limit
    })
  }

  // An incoming message that was never published is kept however old it is: it is a held message
  // waiting for the crash recovery of the order buffer, and deleting it would lose it
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.storedMessage.deleteMany({
      where: {
        receivedAt: { lt: cutoff },
        OR: [{ emittedAt: { not: null } }, { direction: 'out' }]
      }
    })
    return count
  }
}
