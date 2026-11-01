import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError } from '../common/errors.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

// The calls of a session: a link for a scheduled call, and rejecting an incoming one. wwebjs can
// only reject through the call it delivered with the `call` event, so the adapter keeps the most
// recent ones (`CALL_CACHE_SIZE`).
@Injectable()
export class CallsService {
  constructor(@Inject(SessionManager) private readonly sessions: SessionManager) {}

  createLink(sessionId: string, startTime: string, callType: string): Promise<string> {
    return this.sessions.requireReady(sessionId).createCallLink(new Date(startTime), callType)
  }

  // A call the adapter no longer holds (too old, already rejected, or never seen) is a 404
  async reject(sessionId: string, callId: string): Promise<void> {
    const rejected = await this.sessions.requireReady(sessionId).rejectCall(callId)
    if (!rejected) throw new NotFoundError('NOT_FOUND', `No recent incoming call ${callId}`)
  }
}
