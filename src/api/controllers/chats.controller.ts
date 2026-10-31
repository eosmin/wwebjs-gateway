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
import { ChatsService } from '../../services/chats.service.js'
import {
  ChatListDto,
  ChatMessagesQueryDto,
  ChatResponseDto,
  MuteChatBodyDto,
  MuteResultDto,
  SessionChatParamsDto,
  SetChatStateBodyDto
} from '../../types/chats.dto.js'
import { MessageListDto } from '../../types/messages.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import type { AnyChatDto } from '../../whatsapp/whatsapp-client.port.js'
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

const CHAT = {
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

// Chats of a session: reading them, the typing and recording indicators, and what the account does
// with a chat (seen, archive, pin, mute, clear, delete). Sending a message is `messages.send`.
@Controller('v1/sessions')
export class ChatsController {
  constructor(@Inject(ChatsService) private readonly chats: ChatsService) {}

  @Get(':sessionId/chats')
  @ZodResponse({ type: ChatListDto })
  @WaOperation({
    id: 'chats.list',
    scope: 'read',
    summary: 'List the chats',
    description:
      'Every chat WhatsApp Web has loaded: private chats, groups and channels. A group carries its participants and a channel its own fields.',
    errors: ON_SESSION,
    examples: { request: null, response: { items: [CHAT] } },
    wwebjs: ['Client.getChats']
  })
  async list(@Param() { sessionId }: SessionIdParamsDto): Promise<ChatListDto> {
    return { items: await this.chats.list(sessionId) }
  }

  @Get(':sessionId/chats/:chatId')
  @ZodResponse({ type: ChatResponseDto })
  @WaOperation({
    id: 'chats.get',
    scope: 'read',
    summary: 'Read a chat',
    description:
      'One chat by its id. Answers 404 `CHAT_NOT_FOUND` when the session has no such chat.',
    errors: ON_CHAT,
    examples: { request: null, response: CHAT },
    wwebjs: ['Client.getChatById']
  })
  get(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<AnyChatDto> {
    return this.chats.get(sessionId, chatId)
  }

  @Get(':sessionId/chats/:chatId/messages')
  @ZodResponse({ type: MessageListDto })
  @WaOperation({
    id: 'chats.messages',
    scope: 'read',
    summary: 'Read the messages of a chat from WhatsApp Web',
    description:
      'The latest messages WhatsApp Web has of the chat, oldest first, up to `limit`. `fromMe` keeps only those the account sent (true) or got (false). The history the gateway stored is `messages.stored`.',
    errors: ON_CHAT,
    examples: { request: null, response: { items: [] } },
    wwebjs: ['Chat.fetchMessages']
  })
  async messages(
    @Param() { sessionId, chatId }: SessionChatParamsDto,
    @Query() { limit, fromMe }: ChatMessagesQueryDto
  ): Promise<MessageListDto> {
    return {
      items: await this.chats.messages(sessionId, chatId, {
        limit,
        ...(fromMe !== undefined && { fromMe })
      })
    }
  }

  @Get(':sessionId/chats/:chatId/pinned-messages')
  @ZodResponse({ type: MessageListDto })
  @WaOperation({
    id: 'chats.pinnedMessages',
    scope: 'read',
    summary: 'Read the pinned messages of a chat',
    description: 'The messages pinned in the chat.',
    errors: ON_CHAT,
    examples: { request: null, response: { items: [] } },
    wwebjs: ['Chat.getPinnedMessages', 'Client.getPinnedMessages']
  })
  async pinnedMessages(
    @Param() { sessionId, chatId }: SessionChatParamsDto
  ): Promise<MessageListDto> {
    return { items: await this.chats.pinned(sessionId, chatId) }
  }

  @Post(':sessionId/chats/:chatId/state')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.setState',
    scope: 'send',
    summary: 'Set the typing or recording indicator',
    description:
      'Shows "typing…" or "recording audio…" to the other side of the chat, or stops it with `clear`. WhatsApp lets the indicator lapse after about 25 s. With `durationMs` (up to 25000) the gateway clears it when that time ends; the countdown is kept in memory, so a restart leaves the indicator to lapse by itself, and a new state on the same chat replaces it. A message sent through `messages.send` shows its own indicator (`humanize`).',
    socket: { command: 'chat.state' },
    errors: ON_CHAT,
    examples: { request: { state: 'typing', durationMs: 3000 }, response: null },
    wwebjs: ['Chat.sendStateTyping', 'Chat.sendStateRecording', 'Chat.clearState']
  })
  setState(
    @Param() { sessionId, chatId }: SessionChatParamsDto,
    @Body() { state, durationMs }: SetChatStateBodyDto
  ): Promise<void> {
    return this.chats.setState(sessionId, chatId, state, durationMs)
  }

  @Post(':sessionId/chats/:chatId/seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.seen',
    scope: 'send',
    summary: 'Mark a chat as seen',
    description:
      'Sends the read receipt of every message of the chat: the other side sees the blue ticks.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.sendSeen', 'Client.sendSeen']
  })
  seen(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.seen(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/mark-unread')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.markUnread',
    scope: 'manage',
    summary: 'Mark a chat as unread',
    description: 'Shows the chat as unread in the linked phone. Nobody else sees it.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.markUnread', 'Client.markChatUnread']
  })
  markUnread(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.markUnread(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.archive',
    scope: 'manage',
    summary: 'Archive a chat',
    description: 'Moves the chat to the archive. Fails with WHATSAPP_ERROR when WhatsApp refuses.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.archive', 'Client.archiveChat']
  })
  archive(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.archive(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/unarchive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.unarchive',
    scope: 'manage',
    summary: 'Unarchive a chat',
    description: 'Takes the chat out of the archive.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.unarchive', 'Client.unarchiveChat']
  })
  unarchive(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.unarchive(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.pin',
    scope: 'manage',
    summary: 'Pin a chat',
    description:
      'Pins the chat to the top of the list. WhatsApp allows three pinned chats; the call fails with WHATSAPP_ERROR beyond that.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.pin', 'Client.pinChat']
  })
  pin(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.pin(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/unpin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.unpin',
    scope: 'manage',
    summary: 'Unpin a chat',
    description: 'Takes the chat off the top of the list.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.unpin', 'Client.unpinChat']
  })
  unpin(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.unpin(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/mute')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ status: HttpStatus.OK, type: MuteResultDto })
  @WaOperation({
    id: 'chats.mute',
    scope: 'manage',
    summary: 'Mute a chat',
    description:
      'Silences the notifications of the chat until `until` (a future date), or for ever without it. Answers 400 for a date that is not in the future. `muteExpiration` is Unix seconds, -1 for ever.',
    errors: ON_CHAT,
    examples: {
      request: { until: '2099-01-01T00:00:00.000Z' },
      response: { isMuted: true, muteExpiration: 4070908800 }
    },
    wwebjs: ['Chat.mute', 'Client.muteChat']
  })
  mute(
    @Param() { sessionId, chatId }: SessionChatParamsDto,
    @Body() { until }: MuteChatBodyDto
  ): Promise<MuteResultDto> {
    return this.chats.mute(sessionId, chatId, until)
  }

  @Post(':sessionId/chats/:chatId/unmute')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ status: HttpStatus.OK, type: MuteResultDto })
  @WaOperation({
    id: 'chats.unmute',
    scope: 'manage',
    summary: 'Unmute a chat',
    description: 'Turns the notifications of the chat back on.',
    errors: ON_CHAT,
    examples: { request: null, response: { isMuted: false, muteExpiration: 0 } },
    wwebjs: ['Chat.unmute', 'Client.unmuteChat']
  })
  unmute(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<MuteResultDto> {
    return this.chats.unmute(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/clear-messages')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.clearMessages',
    scope: 'manage',
    summary: 'Clear the messages of a chat',
    description:
      'Deletes the messages of the chat in the linked account only; the other side keeps them. Cannot be undone. The copy in the gateway store stays until its retention ends. A channel has no history to clear.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.clearMessages']
  })
  clearMessages(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.clearMessages(sessionId, chatId)
  }

  @Delete(':sessionId/chats/:chatId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.delete',
    scope: 'manage',
    summary: 'Delete a chat',
    description:
      'Removes the chat and its messages from the linked account only; the other side keeps them. Cannot be undone. A channel is not deleted here: that is a channels route.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.delete']
  })
  delete(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.delete(sessionId, chatId)
  }

  @Post(':sessionId/chats/:chatId/sync-history')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'chats.syncHistory',
    scope: 'manage',
    summary: 'Ask the phone for the history of a chat',
    description:
      'Asks the linked phone to send the older messages of the chat. They arrive over time as events, not in this answer.',
    errors: ON_CHAT,
    examples: { request: null, response: null },
    wwebjs: ['Chat.syncHistory', 'Client.syncHistory']
  })
  syncHistory(@Param() { sessionId, chatId }: SessionChatParamsDto): Promise<void> {
    return this.chats.syncHistory(sessionId, chatId)
  }
}
