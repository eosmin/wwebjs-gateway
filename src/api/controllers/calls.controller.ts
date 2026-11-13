import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, Res } from '@nestjs/common'
import { ApiAcceptedResponse } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { CallsService } from '../../services/calls.service.js'
import {
  CallLinkResponseDto,
  CallRejectResponseDto,
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
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: CallRejectResponseDto })
  @ApiAcceptedResponse({
    type: CallRejectResponseDto,
    description: 'The reject was handed over but nothing shows that the call ended'
  })
  @WaOperation({
    id: 'calls.reject',
    scope: 'manage',
    summary: 'Reject an incoming call',
    description:
      'Rejects a call the `call` event delivered, through the VoIP stack of WhatsApp Web. WhatsApp gives no answer to a reject, so the answer says what the page showed afterwards: `200 { confirmed: true }` when the page listed the call and it left the list, `202 { confirmed: false, note }` when the reject was handed over and nothing shows that the call ended, including a call the page does not list under that id (do not assume the caller stopped ringing). `404 NOT_FOUND` when the gateway no longer holds the call (`CALL_CACHE_SIZE`), never saw it, or already rejected it. `502 WHATSAPP_ERROR` (`[call-reject]` in the cause) when this WhatsApp Web build has no way to reject. The effect on a real phone is not yet confirmed live (plan 10.4, F30b).',
    errors: ON_SESSION,
    examples: { request: null, response: { confirmed: true } },
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
  async reject(
    @Param() { sessionId, callId }: SessionCallParamsDto,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<CallRejectResponseDto> {
    const answer = await this.calls.reject(sessionId, callId)
    if (!answer.confirmed) void reply.status(HttpStatus.ACCEPTED)
    return answer
  }
}
