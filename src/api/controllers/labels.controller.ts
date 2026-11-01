import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put
} from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { LabelsService } from '../../services/labels.service.js'
import { ChatListDto, SessionChatParamsDto } from '../../types/chats.dto.js'
import type { LabelDto } from '../../types/dto.js'
import {
  AssignLabelsBodyDto,
  LabelListDto,
  LabelResponseDto,
  SessionLabelParamsDto,
  SetChatLabelsBodyDto
} from '../../types/labels.dto.js'
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
const ON_CHAT: ErrorCode[] = [...ON_SESSION, 'CHAT_NOT_FOUND']

const LABEL = { id: '1', name: 'Nuevo cliente', hexColor: '#ff9485' }

// The labels of a WhatsApp Business account: reading them and the chats that carry them, and setting
// the labels of chats. Creating, renaming and deleting a label is not in the library.
@Controller('v1/sessions')
export class LabelsController {
  constructor(@Inject(LabelsService) private readonly labels: LabelsService) {}

  @Get(':sessionId/labels')
  @ZodResponse({ type: LabelListDto })
  @WaOperation({
    id: 'labels.list',
    scope: 'read',
    summary: 'List the labels',
    description:
      'Every label of the account (WhatsApp Business only; an account without labels answers an empty list).',
    errors: ON_SESSION,
    examples: { request: null, response: { items: [LABEL] } },
    wwebjs: ['Client.getLabels', 'Label.id', 'Label.name', 'Label.hexColor']
  })
  async list(@Param() { sessionId }: SessionIdParamsDto): Promise<LabelListDto> {
    return { items: await this.labels.list(sessionId) }
  }

  @Get(':sessionId/labels/:labelId')
  @ZodResponse({ type: LabelResponseDto })
  @WaOperation({
    id: 'labels.get',
    scope: 'read',
    summary: 'Read a label',
    description: 'One label by its id. Answers 404 `NOT_FOUND` when the account has no such label.',
    errors: ON_SESSION,
    examples: { request: null, response: LABEL },
    wwebjs: ['Client.getLabelById']
  })
  get(@Param() { sessionId, labelId }: SessionLabelParamsDto): Promise<LabelDto> {
    return this.labels.get(sessionId, labelId)
  }

  @Get(':sessionId/labels/:labelId/chats')
  @ZodResponse({ type: ChatListDto })
  @WaOperation({
    id: 'labels.chats',
    scope: 'read',
    summary: 'List the chats that carry a label',
    description:
      'The chats the label is on, as `chats.get` would answer them. Answers 404 `NOT_FOUND` when the account has no such label.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: {
        items: [
          {
            id: '5215500000001@c.us',
            archived: false,
            isGroup: false,
            isReadOnly: false,
            isMuted: false,
            muteExpiration: 0,
            name: 'Cliente',
            timestamp: 1767225600,
            unreadCount: 0,
            pinned: false,
            isLocked: false
          }
        ]
      }
    },
    wwebjs: ['Client.getChatsByLabelId', 'Label.getChats']
  })
  async chats(@Param() { sessionId, labelId }: SessionLabelParamsDto): Promise<ChatListDto> {
    return { items: await this.labels.chats(sessionId, labelId) }
  }

  @Post(':sessionId/labels/assign')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'labels.assign',
    scope: 'manage',
    summary: 'Set the labels of several chats',
    description:
      'Every chat in `chatIds` ends with exactly the labels in `labelIds`: the ones listed are added and any other label of those chats is removed, so an empty `labelIds` clears them. An unknown label is `400 VALIDATION_ERROR` and an unknown chat `404 CHAT_NOT_FOUND`, and nothing changes. On an account that is not a Business one there are no labels, so a non-empty `labelIds` is `400`, and an empty one is refused by the page (`502 WHATSAPP_ERROR`).',
    errors: ON_CHAT,
    examples: {
      request: { labelIds: ['1', '3'], chatIds: ['5215500000001@c.us'] },
      response: null
    },
    wwebjs: ['Client.addOrRemoveLabels']
  })
  assign(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { labelIds, chatIds }: AssignLabelsBodyDto
  ): Promise<void> {
    return this.labels.assign(sessionId, labelIds, chatIds)
  }

  @Get(':sessionId/chats/:chatId/labels')
  @ZodResponse({ type: LabelListDto })
  @WaOperation({
    id: 'labels.ofChat',
    scope: 'read',
    summary: 'List the labels of a chat',
    description:
      'The labels on the chat. Answers 404 `CHAT_NOT_FOUND` for a chat the session lacks.',
    errors: ON_CHAT,
    examples: { request: null, response: { items: [LABEL] } },
    wwebjs: ['Client.getChatLabels', 'Chat.getLabels']
  })
  async ofChat(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<LabelListDto> {
    return { items: await this.labels.ofChat(sessionId, chatId) }
  }

  @Put(':sessionId/chats/:chatId/labels')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'labels.setForChat',
    scope: 'manage',
    summary: 'Set the labels of a chat',
    description:
      'The chat ends with exactly the labels in `labelIds`: the ones listed are added and any other is removed, so an empty list clears them. An unknown label is `400 VALIDATION_ERROR`, and nothing changes. On an account that is not a Business one there are no labels, so a non-empty `labelIds` is `400`, and an empty one is refused by the page (`502 WHATSAPP_ERROR`).',
    errors: ON_CHAT,
    examples: { request: { labelIds: ['1', '3'] }, response: null },
    wwebjs: ['Chat.changeLabels']
  })
  setForChat(
    @Param() { sessionId, chatId }: SessionChatParamsDto,
    @Body() { labelIds }: SetChatLabelsBodyDto
  ): Promise<void> {
    return this.labels.setForChat(sessionId, chatId, labelIds)
  }
}
