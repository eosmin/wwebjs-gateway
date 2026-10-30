import { Inject, Injectable } from '@nestjs/common'

import type { IdempotencyKey, JsonInput } from '../models.js'
import { PrismaService } from '../prisma.service.js'

// Another request may delete the row between the failed insert and the read that follows it (the
// purge), which is why the claim tries again; a second miss in a row is not plausible
const CLAIM_ATTEMPTS = 2

export type ClaimResult =
  | { claimed: true }
  // Someone claimed the key first: `existing` says what for and how it ended
  | { claimed: false; existing: IdempotencyKey }

export interface IdempotencyOutcome {
  messageId?: string | null
  response?: JsonInput
}

@Injectable()
export class IdempotencyRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // One INSERT ... ON CONFLICT DO NOTHING, so two concurrent requests with the same key cannot both
  // win
  async claim(sessionId: string, key: string, requestHash: string): Promise<ClaimResult> {
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      const { count } = await this.prisma.idempotencyKey.createMany({
        data: [{ sessionId, key, requestHash }],
        skipDuplicates: true
      })
      if (count === 1) return { claimed: true }
      const existing = await this.find(sessionId, key)
      if (existing !== null) return { claimed: false, existing }
    }
    throw new Error('idempotency key claim lost to a concurrent purge twice')
  }

  find(sessionId: string, key: string): Promise<IdempotencyKey | null> {
    return this.prisma.idempotencyKey.findUnique({ where: { sessionId_key: { sessionId, key } } })
  }

  // The three methods below answer false when the key is unknown or already finished: a key ends
  // once, so a send that is `done` can never turn `failed` and be sent again
  complete(sessionId: string, key: string, outcome: IdempotencyOutcome): Promise<boolean> {
    return this.finish(sessionId, key, 'done', outcome)
  }

  fail(sessionId: string, key: string, outcome: IdempotencyOutcome): Promise<boolean> {
    return this.finish(sessionId, key, 'failed', outcome)
  }

  // Gives the key back when the send never reached the queue, so the client can retry with it. A key
  // that finished is never released: its result is the answer to every replay.
  async release(sessionId: string, key: string): Promise<boolean> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { sessionId, key, status: 'pending' }
    })
    return count > 0
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: cutoff } }
    })
    return count
  }

  private async finish(
    sessionId: string,
    key: string,
    status: 'done' | 'failed',
    outcome: IdempotencyOutcome
  ): Promise<boolean> {
    const { count } = await this.prisma.idempotencyKey.updateMany({
      where: { sessionId, key, status: 'pending' },
      data: { status, messageId: outcome.messageId, response: outcome.response }
    })
    return count > 0
  }
}
