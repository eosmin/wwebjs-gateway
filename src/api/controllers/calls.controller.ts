import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { CallsService } from '../../services/calls.service.js'
import {
  CallLinkResponseDto,
  CreateCallLinkBodyDto,
  SessionCallParamsDto
} from '../../types/calls.dto.js'
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

// Calls cannot be placed or answered through the library. What it offers is a link for a scheduled
// call and rejecting an incoming one; the incoming calls themselves arrive as the `call` event.
@Controller('v1/sessions')
export class CallsController {
  constructor(@Inject(CallsService) private readonly calls: CallsService) {}

  @Post(':sessionId/calls/link')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: CallLinkResponseDto })
  @WaOperation({
    id: 'calls.createLink',
    scope: 'manage',
    summary: 'Create a call link',
    description:
      'A WhatsApp call link for a voice or video call that starts at `startTime`. WhatsApp Web may refuse to make one (`502 WHATSAPP_ERROR`).',
    errors: ON_SESSION,
    examples: {
      request: { startTime: '2026-12-01T10:00:00Z', callType: 'video' },
      response: { link: 'https://call.whatsapp.com/video/XxXxXxXxXxXxXx' }
    },
    wwebjs: ['Client.createCallLink']
  })
  async createLink(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { startTime, callType }: CreateCallLinkBodyDto
  ): Promise<CallLinkResponseDto> {
    return { link: await this.calls.createLink(sessionId, startTime, callType) }
  }

  @Post(':sessionId/calls/:callId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'calls.reject',
    scope: 'manage',
    summary: 'Reject an incoming call',
    description:
      'Rejects a call the `call` event delivered. The gateway keeps the most recent incoming calls only (`CALL_CACHE_SIZE`): a call it no longer holds, never saw, or already rejected is `404 NOT_FOUND`.',
    errors: ON_SESSION,
    examples: { request: null, response: null },
    wwebjs: [
      'Call.reject',
      'Call.id',
      'Call.from',
      'Call.timestamp',
      'Call.isVideo',
      'Call.isGroup',
      'Call.fromMe',
      'Call.canHandleLocally',
      'Call.webClientShouldHandle',
      'Call.participants'
    ]
  })
  reject(@Param() { sessionId, callId }: SessionCallParamsDto): Promise<void> {
    return this.calls.reject(sessionId, callId)
  }
}
