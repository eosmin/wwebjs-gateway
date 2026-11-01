import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError } from '../common/errors.js'
import type { BroadcastDto } from '../types/dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

// The statuses (stories) WhatsApp Web holds, one broadcast per user. Posting a status is
// `messages.send` to `status@broadcast`; this service only reads.
@Injectable()
export class BroadcastsService {
  constructor(@Inject(SessionManager) private readonly sessions: SessionManager) {}

  list(sessionId: string): Promise<BroadcastDto[]> {
    return this.sessions.requireReady(sessionId).getBroadcasts()
  }

  // The page holds no broadcast for a user without statuses: that is a 404, not an empty broadcast
  async get(sessionId: string, broadcastId: string): Promise<BroadcastDto> {
    const broadcast = await this.sessions.requireReady(sessionId).getBroadcastById(broadcastId)
    if (broadcast === null) {
      throw new NotFoundError('NOT_FOUND', `No statuses of ${broadcastId}`)
    }
    return broadcast
  }
}
