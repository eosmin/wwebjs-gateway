import { Inject, Injectable } from '@nestjs/common'

import { isForeignKeyViolation } from '../db-errors.js'
import type { InboundHook } from '../models.js'
import { PrismaService } from '../prisma.service.js'

export interface NewInboundHook {
  sessionId: string
  name: string
  tokenHash: string
}

@Injectable()
export class InboundHooksRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // Null when the session is gone (the foreign key says so)
  async create(data: NewInboundHook): Promise<InboundHook | null> {
    try {
      return await this.prisma.inboundHook.create({ data })
    } catch (error) {
      if (isForeignKeyViolation(error)) return null
      throw error
    }
  }

  findById(id: string): Promise<InboundHook | null> {
    return this.prisma.inboundHook.findUnique({ where: { id } })
  }

  // Revoked hooks are returned too: the caller tells "revoked" from "unknown"
  findByTokenHash(tokenHash: string): Promise<InboundHook | null> {
    return this.prisma.inboundHook.findUnique({ where: { tokenHash } })
  }

  listForSession(sessionId: string): Promise<InboundHook[]> {
    return this.prisma.inboundHook.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' }
    })
  }

  // Revoking twice keeps the first date, also when two requests race; null when the hook does not
  // exist
  async revoke(id: string, at: Date): Promise<InboundHook | null> {
    await this.prisma.inboundHook.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at }
    })
    return this.findById(id)
  }
}
