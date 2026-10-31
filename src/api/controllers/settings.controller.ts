import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Put } from '@nestjs/common'

import type { ErrorCode } from '../../common/errors.js'
import { PresenceProfileService } from '../../services/presence-profile.service.js'
import { SetAccountSettingsBodyDto } from '../../types/presence-profile.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const ON_SESSION: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'SESSION_NOT_READY',
  'WHATSAPP_ERROR'
]

// The settings WhatsApp Web keeps for the account. The settings of the gateway for a session
// (ordering, humanize, send policy) are `PATCH /v1/sessions/:sessionId`.
@Controller('v1/sessions')
export class SettingsController {
  constructor(@Inject(PresenceProfileService) private readonly service: PresenceProfileService) {}

  @Put(':sessionId/settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'settings.update',
    scope: 'manage',
    summary: 'Change the settings of the WhatsApp account',
    description:
      'Sets the automatic download of audio, documents, photos and videos, and the background sync. Send only the settings to change, at least one. WhatsApp has no call for several at once, so they are applied one by one in that order, and a failure leaves the ones before it applied. What was applied is stored in the settings of the session, so every start applies it again.',
    errors: ON_SESSION,
    examples: { request: { autoDownloadVideos: false, backgroundSync: true }, response: null },
    wwebjs: [
      'Client.setAutoDownloadAudio',
      'Client.setAutoDownloadDocuments',
      'Client.setAutoDownloadPhotos',
      'Client.setAutoDownloadVideos',
      'Client.setBackgroundSync'
    ]
  })
  update(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() body: SetAccountSettingsBodyDto
  ): Promise<void> {
    return this.service.setSettings(sessionId, body)
  }
}
