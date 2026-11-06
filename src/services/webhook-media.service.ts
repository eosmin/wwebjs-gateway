import { Inject, Injectable, Logger } from '@nestjs/common'

import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { EventEnvelope } from '../types/events.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { inlineMediaCandidates } from './webhook-payload.js'

// Bytes a base64 text decodes to, without decoding it
function base64Bytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.floor((text.length * 3) / 4) - padding
}

// Downloads, once per event, the files that a webhook in `mediaMode: inline` may receive inside the
// event (TDD §5.5: media is downloaded on demand and inlined only within
// WEBHOOK_INLINE_MEDIA_MAX_BYTES). The dispatcher asks for it only when such a webhook wants the
// event; every other webhook gets the `downloadUrl` that the message already carries.
@Injectable()
export class WebhookMediaService {
  private readonly logger = new Logger(WebhookMediaService.name)

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionManager) private readonly sessions: SessionManager
  ) {}

  // The bytes (base64) by message id. Never rejects: the file that cannot be had is left out, and
  // its webhook still gets the event with the `downloadUrl`, because an event must not be held back
  // for the sake of a file. The log says the session, the event and the kind of failure, never the
  // message id (it holds the number of the chat) nor the text of an error (it can echo a URL).
  async fetchInline(event: EventEnvelope): Promise<Map<string, string>> {
    const bytes = new Map<string, string>()
    const max = this.config.WEBHOOK_INLINE_MEDIA_MAX_BYTES
    const ids = inlineMediaCandidates(event, max)
    if (ids.length === 0) return bytes
    let client: ReturnType<SessionManager['requireReady']>
    try {
      client = this.sessions.requireReady(event.sessionId)
    } catch (error: unknown) {
      this.failed(event, error)
      return bytes
    }
    for (const id of ids) {
      try {
        const media = await client.downloadMedia(id)
        // The size on the message is what WhatsApp Web said; the file is what counts
        if (media !== null && base64Bytes(media.data) <= max) bytes.set(id, media.data)
      } catch (error: unknown) {
        this.failed(event, error)
      }
    }
    return bytes
  }

  private failed(event: EventEnvelope, error: unknown): void {
    const kind = error instanceof Error ? error.name : typeof error
    this.logger.warn(
      `Media of ${event.event} (session ${event.sessionId}, seq ${event.seq}) could not be downloaded: ${kind}`
    )
  }
}
