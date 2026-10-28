import { Inject, Injectable } from '@nestjs/common'

import { isForeignKeyViolation, isSerializationFailure } from '../db-errors.js'
import type { ApiKey } from '../models.js'
import { PrismaService } from '../prisma.service.js'

// Two rotations of one key at once conflict; the loser runs again, which is enough for a pair
const ROTATE_ATTEMPTS = 3

export interface NewApiKey {
  name: string
  keyHash: string
  keyPrefix: string
  // Null = admin key
  sessionId?: string | null
  scopes: string[]
  allowedCidrs?: string[]
  expiresAt?: Date | null
  rotatedFromId?: string | null
}

@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // Null when the session of the key does not exist (any more)
  async create(data: NewApiKey): Promise<ApiKey | null> {
    try {
      return await this.prisma.apiKey.create({ data })
    } catch (error) {
      if (isForeignKeyViolation(error)) return null
      throw error
    }
  }

  findById(id: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findUnique({ where: { id } })
  }

  findByHash(keyHash: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findUnique({ where: { keyHash } })
  }

  list(): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } })
  }

  // The guard debounces the calls, so this is a plain write
  async touchLastUsed(id: string, at: Date): Promise<void> {
    await this.prisma.apiKey.updateMany({ where: { id }, data: { lastUsedAt: at } })
  }

  // Revoking twice keeps the first date, also when two requests race; null when the key does not
  // exist
  async revoke(id: string, at: Date): Promise<ApiKey | null> {
    await this.prisma.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } })
    return this.findById(id)
  }

  // The new key and the end of the old one's life are written together, so a failure cannot leave a
  // consumer with two keys that never expire or with none. A revoked or missing key is not rotated,
  // and the old key never lives longer than it already would (a key that expires sooner keeps its
  // date). Serializable, so a rotation that races a revoke or another rotation is run again
  // instead of reading a stale key.
  // `replacement` receives the old row as the transaction read it, so the copy is never stale.
  async rotate(
    oldId: string,
    replacement: (old: ApiKey) => NewApiKey,
    oldExpiresAt: Date
  ): Promise<ApiKey | null> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.rotateOnce(oldId, replacement, oldExpiresAt)
      } catch (error) {
        if (!isSerializationFailure(error) || attempt >= ROTATE_ATTEMPTS) throw error
      }
    }
  }

  private rotateOnce(
    oldId: string,
    replacement: (old: ApiKey) => NewApiKey,
    oldExpiresAt: Date
  ): Promise<ApiKey | null> {
    return this.prisma.$transaction(
      async tx => {
        const old = await tx.apiKey.findUnique({ where: { id: oldId } })
        if (old === null || old.revokedAt !== null) return null
        const expiresAt =
          old.expiresAt !== null && old.expiresAt < oldExpiresAt ? old.expiresAt : oldExpiresAt
        await tx.apiKey.update({ where: { id: oldId }, data: { expiresAt } })
        return tx.apiKey.create({ data: { ...replacement(old), rotatedFromId: oldId } })
      },
      { isolationLevel: 'Serializable' }
    )
  }
}
