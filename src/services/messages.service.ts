import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError, WhatsAppError } from '../common/errors.js'
import type {
  GroupChatDto,
  MessageDto,
  MessageInfoDto,
  OrderDto,
  PaymentDto,
  ReactionListDto
} from '../types/dto.js'
import type { EditMessageBodyDto, PIN_DURATIONS } from '../types/messages.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type {
  AnyContactDto,
  DownloadedMedia,
  SearchMessagesOptions
} from '../whatsapp/whatsapp-client.port.js'

import { MessageStoreService, type StoredMessagesPage } from './message-store.service.js'
import type { SendJobStatus } from './send-queue.job.js'
import { SendQueueService } from './send-queue.service.js'

export type PinDuration = (typeof PIN_DURATIONS)[number]

// What the messages routes do besides sending: reads and actions on one message, each one a call
// to the session's client. Sending itself is `MessageSendService`.
@Injectable()
export class MessagesService {
  constructor(
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(SendQueueService) private readonly queue: SendQueueService,
    @Inject(MessageStoreService) private readonly store: MessageStoreService
  ) {}

  // ---- Reads -----------------------------------------------------------------------------------

  sendJob(sessionId: string, jobId: string): Promise<SendJobStatus> {
    return this.queue.status(sessionId, jobId)
  }

  async get(sessionId: string, messageId: string): Promise<MessageDto> {
    return this.found(await this.client(sessionId).getMessageById(messageId), messageId)
  }

  async search(
    sessionId: string,
    query: string,
    options: SearchMessagesOptions
  ): Promise<MessageDto[]> {
    return this.client(sessionId).searchMessages(query, options)
  }

  stored(
    sessionId: string,
    query: { chatId?: string | undefined; cursor?: string | undefined; limit: number }
  ): Promise<StoredMessagesPage> {
    this.sessions.status(sessionId)
    return this.store.list({
      sessionId,
      limit: query.limit,
      ...(query.chatId !== undefined && { chatId: query.chatId }),
      ...(query.cursor !== undefined && { cursor: query.cursor })
    })
  }

  async media(sessionId: string, messageId: string): Promise<DownloadedMedia> {
    const media = await this.client(sessionId).downloadMedia(messageId)
    if (media === null) {
      throw new NotFoundError('NOT_FOUND', `Message ${messageId} has no media available`)
    }
    return media
  }

  async quoted(sessionId: string, messageId: string): Promise<MessageDto> {
    return this.found(await this.client(sessionId).getQuotedMessage(messageId), messageId)
  }

  mentions(sessionId: string, messageId: string): Promise<AnyContactDto[]> {
    return this.client(sessionId).getMessageMentions(messageId)
  }

  groupMentions(sessionId: string, messageId: string): Promise<GroupChatDto[]> {
    return this.client(sessionId).getMessageGroupMentions(messageId)
  }

  async info(sessionId: string, messageId: string): Promise<MessageInfoDto> {
    return this.found(await this.client(sessionId).getMessageInfo(messageId), messageId)
  }

  order(sessionId: string, messageId: string): Promise<OrderDto> {
    return this.client(sessionId).getMessageOrder(messageId)
  }

  payment(sessionId: string, messageId: string): Promise<PaymentDto> {
    return this.client(sessionId).getMessagePayment(messageId)
  }

  reactions(sessionId: string, messageId: string): Promise<ReactionListDto[]> {
    return this.client(sessionId).getMessageReactions(messageId)
  }

  // ---- Actions ---------------------------------------------------------------------------------

  react(sessionId: string, messageId: string, reaction: string): Promise<void> {
    return this.client(sessionId).sendReaction(messageId, reaction)
  }

  star(sessionId: string, messageId: string): Promise<void> {
    return this.client(sessionId).starMessage(messageId)
  }

  unstar(sessionId: string, messageId: string): Promise<void> {
    return this.client(sessionId).unstarMessage(messageId)
  }

  async pin(sessionId: string, messageId: string, duration: PinDuration): Promise<void> {
    if (!(await this.client(sessionId).pinMessage(messageId, duration))) {
      throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp did not pin the message')
    }
  }

  async unpin(sessionId: string, messageId: string): Promise<void> {
    if (!(await this.client(sessionId).unpinMessage(messageId))) {
      throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp did not unpin the message')
    }
  }

  async edit(sessionId: string, messageId: string, body: EditMessageBodyDto): Promise<MessageDto> {
    const edited = await this.client(sessionId).editMessage(
      messageId,
      { type: 'text', body: body.body },
      {
        ...(body.linkPreview !== undefined && { linkPreview: body.linkPreview }),
        ...(body.mentions !== undefined && { mentions: body.mentions })
      }
    )
    if (edited === null) {
      throw new WhatsAppError(
        'WHATSAPP_ERROR',
        'The message could not be edited: only your own text messages can be, for a limited time'
      )
    }
    return edited
  }

  delete(
    sessionId: string,
    messageId: string,
    options: { everyone: boolean; clearMedia: boolean }
  ): Promise<void> {
    return this.client(sessionId).deleteMessage(messageId, options.everyone, options.clearMedia)
  }

  revokeStatus(sessionId: string, messageId: string): Promise<void> {
    return this.client(sessionId).revokeStatusMessage(messageId)
  }

  // ---- Helpers ---------------------------------------------------------------------------------

  private client(sessionId: string): ReturnType<SessionManager['requireReady']> {
    return this.sessions.requireReady(sessionId)
  }

  private found<T>(value: T | null, messageId: string): T {
    if (value === null) throw new NotFoundError('NOT_FOUND', `Message ${messageId} does not exist`)
    return value
  }
}
