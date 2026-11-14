import { Controller, Get, Inject, Param } from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { BroadcastsService } from '../../services/broadcasts.service.js'
import {
  BroadcastListDto,
  BroadcastResponseDto,
  SessionBroadcastParamsDto
} from '../../types/broadcasts.dto.js'
import type { BroadcastDto } from '../../types/dto.js'
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

const BROADCAST = {
  id: '5215500000001@c.us',
  timestamp: 1767225600,
  totalCount: 0,
  unreadCount: 0,
  msgs: []
}

// The statuses (stories) of the users WhatsApp Web holds. They are read-only here: a status is
// posted with `messages.send` to `status@broadcast`, and revoked with `messages.revokeStatus`.
@Controller('v1/sessions')
export class BroadcastsController {
  constructor(@Inject(BroadcastsService) private readonly broadcasts: BroadcastsService) {}

  @Get(':sessionId/broadcasts')
  @ZodResponse({ type: BroadcastListDto })
  @WaOperation({
    id: 'broadcasts.list',
    scope: 'read',
    summary: 'List the broadcasts (statuses)',
    description:
      'The status updates WhatsApp Web holds, one broadcast per user (the account itself included).',
    socket: { command: 'broadcast.list' },
    errors: ON_SESSION,
    examples: { request: null, response: { items: [BROADCAST] } },
    wwebjs: [
      'Client.getBroadcasts',
      'Broadcast.id',
      'Broadcast.timestamp',
      'Broadcast.totalCount',
      'Broadcast.unreadCount',
      'Broadcast.msgs'
    ]
  })
  async list(@Param() { sessionId }: SessionIdParamsDto): Promise<BroadcastListDto> {
    return { items: await this.broadcasts.list(sessionId) }
  }

  @Get(':sessionId/broadcasts/:broadcastId')
  @ZodResponse({ type: BroadcastResponseDto })
  @WaOperation({
    id: 'broadcasts.get',
    scope: 'read',
    summary: 'Read the broadcast (statuses) of a user',
    description:
      'The status updates of one user. Answers 404 `NOT_FOUND` when WhatsApp Web holds none of that user.',
    socket: { command: 'broadcast.get' },
    errors: ON_SESSION,
    examples: { request: null, response: BROADCAST },
    wwebjs: ['Client.getBroadcastById']
  })
  get(@Param() { sessionId, broadcastId }: SessionBroadcastParamsDto): Promise<BroadcastDto> {
    return this.broadcasts.get(sessionId, broadcastId)
  }
}
