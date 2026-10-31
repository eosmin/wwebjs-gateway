import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put
} from '@nestjs/common'

import type { ErrorCode } from '../../common/errors.js'
import { PresenceProfileService } from '../../services/presence-profile.service.js'
import {
  SetDisplayNameBodyDto,
  SetPresenceBodyDto,
  SetProfilePictureBodyDto,
  SetProfileStatusBodyDto
} from '../../types/presence-profile.dto.js'
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
const ON_PICTURE: ErrorCode[] = [...ON_SESSION, 'PAYLOAD_TOO_LARGE', 'MEDIA_FETCH_FAILED']

// The presence of the account and its profile (name, about text, picture)
@Controller('v1/sessions')
export class PresenceProfileController {
  constructor(@Inject(PresenceProfileService) private readonly service: PresenceProfileService) {}

  @Post(':sessionId/presence')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'presence.set',
    scope: 'manage',
    summary: 'Show the account as online or offline',
    description:
      '`available` shows the account as online to its contacts; `unavailable` as offline. While the account is available the linked phone gets no push notifications.',
    errors: ON_SESSION,
    examples: { request: { state: 'available' }, response: null },
    wwebjs: ['Client.sendPresenceAvailable', 'Client.sendPresenceUnavailable']
  })
  setPresence(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { state }: SetPresenceBodyDto
  ): Promise<void> {
    return this.service.setPresence(sessionId, state)
  }

  @Put(':sessionId/profile/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'profile.setStatus',
    scope: 'manage',
    summary: 'Change the "about" text of the profile',
    description: 'Sets the text under the name of the account, up to 139 characters.',
    errors: ON_SESSION,
    examples: { request: { status: 'Atendemos de 9 a 18 h' }, response: null },
    wwebjs: ['Client.setStatus']
  })
  setStatus(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { status }: SetProfileStatusBodyDto
  ): Promise<void> {
    return this.service.setStatus(sessionId, status)
  }

  @Put(':sessionId/profile/display-name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'profile.setDisplayName',
    scope: 'manage',
    summary: 'Change the name of the profile',
    description:
      'Sets the name the account shows, up to 25 characters. Fails with WHATSAPP_ERROR when WhatsApp refuses.',
    errors: ON_SESSION,
    examples: { request: { displayName: 'Soporte' }, response: null },
    wwebjs: ['Client.setDisplayName']
  })
  setDisplayName(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { displayName }: SetDisplayNameBodyDto
  ): Promise<void> {
    return this.service.setDisplayName(sessionId, displayName)
  }

  @Put(':sessionId/profile/picture')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'profile.setPicture',
    scope: 'manage',
    summary: 'Change the profile picture',
    description:
      'Sets the picture from inline `base64`, a public `url` or the image of a stored message. Anything that is not an image is a 400. A `url` goes through the SSRF guard and the size cap `MAX_MEDIA_BYTES`; the body of a request is limited to 1 MiB, so a larger image goes by `url`.',
    errors: ON_PICTURE,
    examples: {
      request: { source: { url: 'https://example.com/logo.png' } },
      response: null
    },
    wwebjs: ['Client.setProfilePicture']
  })
  setPicture(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { source }: SetProfilePictureBodyDto
  ): Promise<void> {
    return this.service.setPicture(sessionId, source)
  }

  @Delete(':sessionId/profile/picture')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'profile.deletePicture',
    scope: 'manage',
    summary: 'Delete the profile picture',
    description:
      'Removes the picture of the profile. Fails with WHATSAPP_ERROR when WhatsApp refuses.',
    errors: ON_SESSION,
    examples: { request: null, response: null },
    wwebjs: ['Client.deleteProfilePicture']
  })
  deletePicture(@Param() { sessionId }: SessionIdParamsDto): Promise<void> {
    return this.service.deletePicture(sessionId)
  }
}
