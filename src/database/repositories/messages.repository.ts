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
  ack: number | null
  sentAt: Date
  receivedAt: Date
  origin?: JsonInput
  // See the `policyText` column: set only for a short incoming text when bodies are not stored
  policyText?: string
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

export interface OutgoingState {
  ack: number | null
  sentAt: Date
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

  // The ack only moves forward: WhatsApp can re-emit an older one after a reconnect, and it must not
  // lower a newer one. -1 (error) always applies, and an ack after an error applies too (a resend). A
  // message stored without an ack takes the first one (SQL compares NULL with nothing, so it is
  // asked for apart). False when nothing changed (not stored, or older).
  async updateAck(sessionId: string, id: string, ack: number): Promise<boolean> {
    const moves = ack === -1 ? { NOT: { ack: -1 } } : { ack: { lt: ack } }
    const { count } = await this.prisma.storedMessage.updateMany({
      where: { sessionId, id, OR: [{ ack: null }, moves] },
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

  // Marks as seen by the send policy and drops the text kept for it; a row that already has a
  // date keeps it
  async markPolicyHandled(sessionId: string, ids: string[], at: Date): Promise<number> {
    const { count } = await this.prisma.storedMessage.updateMany({
      where: { sessionId, id: { in: ids }, policyHandledAt: null },
      data: { policyHandledAt: at, policyText: null }
    })
    return count
  }

  // Incoming messages the send policy has not seen yet (the process died or the policy failed
  // after they were stored), oldest first so an opt-out and what follows it keep their order
  listPolicyPending(sessionId: string): Promise<StoredMessage[]> {
    return this.prisma.storedMessage.findMany({
      where: { sessionId, direction: 'in', policyHandledAt: null },
      orderBy: [{ sentAt: 'asc' }, { receivedAt: 'asc' }]
    })
  }

  // Incoming messages that were stored but not yet published (held when the process died, or whose
  // publishing failed), in the order they were sent, to be fed again through the order buffer.
  // `chatId` narrows it to one chat.
  listUnemitted(sessionId: string, chatId?: string): Promise<StoredMessage[]> {
    return this.prisma.storedMessage.findMany({
      where: { sessionId, chatId, direction: 'in', emittedAt: null },
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

  // When the contact last wrote in this chat, by the gateway's clock (the arrival, not the sender's
  // timestamp, which a wrong phone clock can put in the future); null when it never did, or the
  // retention already removed it
  async lastIncomingAt(sessionId: string, chatId: string): Promise<Date | null> {
    const row = await this.prisma.storedMessage.findFirst({
      where: { sessionId, chatId, direction: 'in' },
      orderBy: { receivedAt: 'desc' },
      select: { receivedAt: true }
    })
    return row?.receivedAt ?? null
  }

  // The last messages we sent to a chat, newest first, with the delivery state the send policy
  // reads to tell an unreachable recipient
  listRecentOutgoing(sessionId: string, chatId: string, limit: number): Promise<OutgoingState[]> {
    return this.prisma.storedMessage.findMany({
      where: { sessionId, chatId, direction: 'out' },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { ack: true, sentAt: true }
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
