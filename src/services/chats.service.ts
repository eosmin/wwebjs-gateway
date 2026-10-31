import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'

import { ValidationError, WhatsAppError } from '../common/errors.js'
import type { MessageDto } from '../types/dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type {
  AnyChatDto,
  ChatStateKind,
  FetchMessagesOptions,
  MuteResult,
  WhatsAppClientPort
} from '../whatsapp/whatsapp-client.port.js'

type ChatCall =
  | 'sendSeen'
  | 'archiveChat'
  | 'unarchiveChat'
  | 'pinChat'
  | 'unpinChat'
  | 'clearChatMessages'
  | 'deleteChat'
  | 'syncHistory'

// What the chats routes do: reads, the typing and recording indicators, and the actions on one chat,
// each a call to the session's client.
@Injectable()
export class ChatsService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatsService.name)
  // The countdowns that clear an indicator, one per chat of a session
  private readonly countdowns = new Map<string, NodeJS.Timeout>()

  constructor(@Inject(SessionManager) private readonly sessions: SessionManager) {}

  onModuleDestroy(): void {
    for (const timer of this.countdowns.values()) clearTimeout(timer)
    this.countdowns.clear()
  }

  // ---- Reads -----------------------------------------------------------------------------------

  async list(sessionId: string): Promise<AnyChatDto[]> {
    return this.sessions.requireReady(sessionId).getChats()
  }

  async get(sessionId: string, chatId: string): Promise<AnyChatDto> {
    return this.sessions.requireReady(sessionId).getChatById(chatId)
  }

  async messages(
    sessionId: string,
    chatId: string,
    options: FetchMessagesOptions
  ): Promise<MessageDto[]> {
    const client = await this.existing(sessionId, chatId)
    return client.fetchMessages(chatId, options)
  }

  async pinned(sessionId: string, chatId: string): Promise<MessageDto[]> {
    const client = await this.existing(sessionId, chatId)
    return client.getPinnedMessages(chatId)
  }

  // ---- Indicators ------------------------------------------------------------------------------

  // WhatsApp shows the indicator for about 25 s. With a duration the gateway clears it when that
  // ends; the countdown lives in memory, so a restart leaves the indicator to lapse by itself.
  async setState(
    sessionId: string,
    chatId: string,
    state: ChatStateKind,
    durationMs?: number
  ): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    await client.sendChatState(chatId, state)
    // The new state takes over the old countdown only once WhatsApp took it, and after the call, so
    // that two overlapping requests cannot leave a timer nobody can cancel
    const key = `${sessionId}\u0000${chatId}`
    this.cancel(key)
    if (state === 'clear' || durationMs === undefined) return
    const timer = setTimeout(() => {
      this.countdowns.delete(key)
      void this.clearAfterCountdown(sessionId, chatId)
    }, durationMs)
    timer.unref()
    this.countdowns.set(key, timer)
  }

  // With the client the session has now: the one that showed the indicator may be gone by then
  private async clearAfterCountdown(sessionId: string, chatId: string): Promise<void> {
    try {
      await this.sessions.requireReady(sessionId).sendChatState(chatId, 'clear')
    } catch (error: unknown) {
      this.logger.debug(`[${sessionId}] clearing the chat state failed (${errorName(error)})`)
    }
  }

  // ---- Actions ---------------------------------------------------------------------------------

  markUnread(sessionId: string, chatId: string): Promise<void> {
    return this.existing(sessionId, chatId).then(client => client.markChatUnread(chatId))
  }

  seen(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'sendSeen', 'mark the chat as seen')
  }

  archive(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'archiveChat', 'archive the chat')
  }

  unarchive(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'unarchiveChat', 'unarchive the chat')
  }

  pin(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'pinChat', 'pin the chat')
  }

  unpin(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'unpinChat', 'unpin the chat')
  }

  clearMessages(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'clearChatMessages', 'clear the messages of the chat')
  }

  delete(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'deleteChat', 'delete the chat')
  }

  syncHistory(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'syncHistory', 'request the history of the chat')
  }

  async mute(sessionId: string, chatId: string, until?: string): Promise<MuteResult> {
    const end = until === undefined ? undefined : new Date(until)
    if (end !== undefined && end.getTime() <= Date.now()) {
      throw new ValidationError('VALIDATION_ERROR', 'The end of the mute must be in the future', {
        until
      })
    }
    const client = await this.existing(sessionId, chatId)
    return end === undefined ? client.muteChat(chatId) : client.muteChat(chatId, end)
  }

  async unmute(sessionId: string, chatId: string): Promise<MuteResult> {
    const client = await this.existing(sessionId, chatId)
    return client.unmuteChat(chatId)
  }

  // ---- Helpers ---------------------------------------------------------------------------------

  // The client, once the chat is known to exist: WhatsApp Web answers a call on a chat it does not
  // have with a failure that cannot be told from a real one, and this way the caller gets a 404
  private async existing(sessionId: string, chatId: string): Promise<WhatsAppClientPort> {
    const client = this.sessions.requireReady(sessionId)
    await client.getChatById(chatId)
    return client
  }

  // A call that answers false when WhatsApp Web did not do it
  private async done(
    sessionId: string,
    chatId: string,
    call: ChatCall,
    what: string
  ): Promise<void> {
    const client = await this.existing(sessionId, chatId)
    if (!(await client[call](chatId))) {
      throw new WhatsAppError('WHATSAPP_ERROR', `WhatsApp did not ${what}`)
    }
  }

  private cancel(key: string): void {
    const timer = this.countdowns.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.countdowns.delete(key)
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error)
