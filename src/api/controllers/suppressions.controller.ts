import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query
} from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { SendPolicyAdminService } from '../../services/send-policy-admin.service.js'
import {
  AddSuppressionBodyDto,
  AddedSuppressionDto,
  SuppressionListDto,
  SuppressionListQueryDto,
  SuppressionParamsDto,
  UnreachableChatsDto
} from '../../types/send-policy-api.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const ON_SESSION: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'INTERNAL'
]

// The chats the gateway refuses to message: the suppression list, and the chats the policy has
// flagged as unreachable (TDD §6.8.1). Gateway-native.
@Controller('v1/sessions')
export class SuppressionsController {
  constructor(@Inject(SendPolicyAdminService) private readonly service: SendPolicyAdminService) {}

  @Get(':sessionId/suppressions')
  @ZodResponse({ type: SuppressionListDto })
  @WaOperation({
    id: 'suppressions.list',
    scope: 'read',
    summary: 'List the suppressed chats of a session',
    description:
      'Every chat that rejects sends with `RECIPIENT_SUPPRESSED`, newest first, with why it is there (`manual` from the API, `opt_out` from an opt-out keyword). Page with `cursor`: take `nextCursor` of one page as the `cursor` of the next, and stop when it is null.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: {
        items: [
          {
            chatId: '100000000000001@lid',
            reason: 'manual',
            note: 'asked by phone',
            createdAt: '2026-10-31T12:00:00.000Z'
          }
        ],
        nextCursor: null
      }
    },
    wwebjs: [],
    gateway: true
  })
  list(
    @Param() { sessionId }: SessionIdParamsDto,
    @Query() query: SuppressionListQueryDto
  ): Promise<SuppressionListDto> {
    return this.service.listSuppressions(sessionId, query)
  }

  @Post(':sessionId/suppressions')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: AddedSuppressionDto })
  @WaOperation({
    id: 'suppressions.add',
    scope: 'manage',
    summary: 'Stop sending to a chat',
    description:
      'Puts a chat on the suppression list: every later send to it is rejected with `RECIPIENT_SUPPRESSED`, replies included. `chatId` is a WhatsApp id, or a phone number that is turned into the id the sends use (it needs the session to be ready, unless the number was looked up lately, and counts as a number look-up). The id to suppress is the `chatId` of the incoming messages of that contact. Adding a chat that is already listed answers `created: false` and changes nothing; a new entry publishes `chat_suppressed`.',
    errors: [...ON_SESSION, 'SESSION_NOT_READY', 'NUMBER_NOT_ON_WHATSAPP', 'POLICY_BLOCKED'],
    examples: {
      request: { chatId: '5215500000001', note: 'asked by phone' },
      response: {
        chatId: '100000000000001@lid',
        reason: 'manual',
        note: 'asked by phone',
        createdAt: '2026-10-31T12:00:00.000Z',
        created: true
      }
    },
    wwebjs: [],
    gateway: true
  })
  add(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { chatId, note }: AddSuppressionBodyDto
  ): Promise<AddedSuppressionDto> {
    return this.service.addSuppression(sessionId, chatId, note)
  }

  @Delete(':sessionId/suppressions/:chatId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'suppressions.remove',
    scope: 'manage',
    summary: 'Allow sending to a suppressed chat again',
    description:
      'Takes a chat off the suppression list (`404 NOT_FOUND` when it was not on it). `chatId` is the id as `GET …/suppressions` shows it. The other rules of the send policy still apply.',
    errors: ON_SESSION,
    examples: { request: null, response: null },
    wwebjs: [],
    gateway: true
  })
  remove(@Param() { sessionId, chatId }: SuppressionParamsDto): Promise<void> {
    return this.service.removeSuppression(sessionId, chatId)
  }

  @Get(':sessionId/unreachable-chats')
  @ZodResponse({ type: UnreachableChatsDto })
  @WaOperation({
    id: 'unreachableChats.list',
    scope: 'read',
    summary: 'List the chats flagged as unreachable',
    description:
      'The chats the policy flagged as possibly blocked or dead: silent for `UNREACHABLE_MIN_AGE_HOURS` while the last `UNREACHABLE_STREAK` messages sent to them stayed below ack 2. Only new conversations are refused for it (`RECIPIENT_UNREACHABLE`). The flag is set and cleared when a send to the chat is checked, so the list is as of the last check; at most 1000 chats are listed.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: { items: [{ chatId: '100000000000001@lid' }], truncated: false }
    },
    wwebjs: [],
    gateway: true
  })
  unreachable(@Param() { sessionId }: SessionIdParamsDto): Promise<UnreachableChatsDto> {
    return this.service.unreachableChats(sessionId)
  }
}
