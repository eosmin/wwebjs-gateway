import { Inject, Injectable } from '@nestjs/common'

import type { SessionStatus } from '../../types/dto.js'
import { nullIfMissing } from '../db-errors.js'
import type { JsonInput, Session } from '../models.js'
import { PrismaService } from '../prisma.service.js'

export interface NewSession {
  id: string
  name?: string | null
  autoStart?: boolean
  settings?: JsonInput
}

// Only the columns that change over the life of a session; undefined leaves a column as it is
export interface SessionPatch {
  name?: string | null
  status?: SessionStatus
  phoneNumber?: string | null
  pushName?: string | null
  autoStart?: boolean
  settings?: JsonInput
  lastConnectedAt?: Date | null
  lastEventAt?: Date | null
  linkedAt?: Date | null
  lastError?: string | null
  seqHighWater?: bigint
}

@Injectable()
export class SessionsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  create(data: NewSession): Promise<Session> {
    return this.prisma.session.create({ data })
  }

  findById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } })
  }

  list(): Promise<Session[]> {
    return this.prisma.session.findMany({ orderBy: { createdAt: 'asc' } })
  }

  // The sessions the manager starts on boot
  listAutoStart(): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: { autoStart: true },
      orderBy: { createdAt: 'asc' }
    })
  }

  // Never lowers the bound: a write that arrives late (after a timeout) cannot undo a newer one
  async raiseSeqHighWater(id: string, value: bigint): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, seqHighWater: { lt: value } },
      data: { seqHighWater: value }
    })
  }

  update(id: string, patch: SessionPatch): Promise<Session | null> {
    return nullIfMissing(this.prisma.session.update({ where: { id }, data: patch }))
  }

  // Adds the keys of `patch` to `settings` in one statement, so two writers that each own other keys
  // (this API, the send policy) never overwrite each other. A stored value that is not an object is
  // replaced. `updatedAt` takes the clock of the process, as Prisma does for the other writes, so the
  // two never disagree. False when the session does not exist.
  async mergeSettings(id: string, patch: Readonly<Record<string, JsonInput>>): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "sessions"
      SET "settings" = (CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END)
                       || ${JSON.stringify(patch)}::jsonb,
          "updatedAt" = ${new Date()}
      WHERE "id" = ${id}`
    return count > 0
  }

  // Cascades to keys, webhooks, inbound hooks, messages and suppressions; false when it did not exist
  async delete(id: string): Promise<boolean> {
    const { count } = await this.prisma.session.deleteMany({ where: { id } })
    return count > 0
  }
}
