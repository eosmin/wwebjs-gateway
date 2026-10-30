import { Inject, Injectable } from '@nestjs/common'

import {
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableError,
  ValidationError
} from '../common/errors.js'
import { resolveMimetype } from '../common/lib/mime.js'
import { downloadPublicFile } from '../common/lib/public-download.js'
import { Semaphore } from '../common/lib/semaphore.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { MediaSource } from '../types/messages.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type { OutboundMedia } from '../whatsapp/whatsapp-client.port.js'

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
// A base64 text carries 3 bytes in every 4 characters, less what the `=` padding takes
const decodedSize = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

// Gets the bytes of the media of a send from wherever the request says they are
@Injectable()
export class MediaResolverService {
  // Each download can hold the file several times over while it is converted, so they take turns
  private readonly downloads: Semaphore

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionManager) private readonly sessions: SessionManager
  ) {
    this.downloads = new Semaphore(config.MEDIA_FETCH_CONCURRENCY)
  }

  async resolve(sessionId: string, source: MediaSource): Promise<OutboundMedia> {
    if ('base64' in source) return this.inline(source)
    if ('url' in source) return this.fromUrl(source)
    return this.fromMessage(sessionId, source.messageId)
  }

  private inline(source: Extract<MediaSource, { base64: string }>): OutboundMedia {
    this.assertWithinCap(source.base64)
    if (source.base64.length % 4 !== 0 || !BASE64_PATTERN.test(source.base64)) {
      throw new ValidationError('VALIDATION_ERROR', 'source.base64 is not valid base64', {
        field: 'source.base64'
      })
    }
    return {
      mimetype: source.mimetype,
      data: source.base64,
      ...(source.filename !== undefined && { filename: source.filename })
    }
  }

  private assertWithinCap(base64: string): void {
    if (decodedSize(base64) > this.config.MAX_MEDIA_BYTES) {
      throw new PayloadTooLargeError(
        'PAYLOAD_TOO_LARGE',
        `The media is larger than MAX_MEDIA_BYTES (${this.config.MAX_MEDIA_BYTES} bytes)`
      )
    }
  }

  // The SSRF guard, the size cap and the timeout live in the download itself
  private async fromUrl(source: Extract<MediaSource, { url: string }>): Promise<OutboundMedia> {
    const file = await this.downloads.run(() =>
      downloadPublicFile(source.url, {
        policy: {
          privateHostAllowlist: this.config.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
          allowPrivate: this.config.ALLOW_PRIVATE_WEBHOOK_TARGETS
        },
        maxBytes: this.config.MAX_MEDIA_BYTES,
        timeoutMs: this.config.MEDIA_FETCH_TIMEOUT_MS
      })
    )
    const mimetype = resolveMimetype(file.contentType, file.data)
    if (mimetype === undefined) {
      throw new UnprocessableError(
        'MEDIA_FETCH_FAILED',
        'The media could not be downloaded: the server sent no content type and the file is not a known format',
        { reason: 'unknown content type' }
      )
    }
    return {
      mimetype,
      data: file.data.toString('base64'),
      ...(source.filename !== undefined && { filename: source.filename })
    }
  }

  private async fromMessage(sessionId: string, messageId: string): Promise<OutboundMedia> {
    // The browser hands the whole file over as base64, so it takes its turn like a download
    const client = this.sessions.requireReady(sessionId)
    const media = await this.downloads.run(() => client.downloadMedia(messageId))
    if (media === null) {
      throw new NotFoundError('NOT_FOUND', `Message ${messageId} has no media available`)
    }
    this.assertWithinCap(media.data)
    return {
      mimetype: media.mimetype,
      data: media.data,
      ...(media.filename != null && { filename: media.filename })
    }
  }
}
