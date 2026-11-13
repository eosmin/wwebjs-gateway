import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError } from '../common/errors.js'
import type { CallRejectResponse } from '../types/calls.dto.js'
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

  // WhatsApp gives no answer to a reject, so what is answered is what the page shows afterwards:
  // `confirmed` when the call left its list, `confirmed: false` with a note when the reject was
  // handed over and nothing shows that the call ended. A call the adapter no longer holds (too old,
  // already rejected, or never seen) is a 404.
  async reject(sessionId: string, callId: string): Promise<CallRejectResponse> {
    const result = await this.sessions.requireReady(sessionId).rejectCall(callId)
    if (result === 'not_held')
      throw new NotFoundError('NOT_FOUND', `No recent incoming call ${callId}`)
    return result === 'confirmed'
      ? { confirmed: true }
      : { confirmed: false, note: UNCONFIRMED_NOTE }
  }
}

export const UNCONFIRMED_NOTE =
  'The reject was handed to the VoIP stack of WhatsApp Web; its effect cannot be confirmed from the page, so do not assume the caller stopped ringing.'
