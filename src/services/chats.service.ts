import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'

import { NotFoundError, ValidationError, WhatsAppError } from '../common/errors.js'
import type { MessageDto } from '../types/dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type {
  AnyChatDto,
  ChatStateKind,
  CustomerNote,
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
// Reads of the chat after an unarchive or an unpin, and the pause between them
const UNDO_READS = 3
const UNDO_READ_PAUSE_MS = 150

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
    return this.undone(sessionId, chatId, 'unarchiveChat', 'unarchive the chat', 'archived')
  }

  pin(sessionId: string, chatId: string): Promise<void> {
    return this.done(sessionId, chatId, 'pinChat', 'pin the chat')
  }

  unpin(sessionId: string, chatId: string): Promise<void> {
    return this.undone(sessionId, chatId, 'unpinChat', 'unpin the chat', 'pinned')
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

  // ---- Customer notes (WhatsApp Business) --------------------------------------------------------

  async customerNote(sessionId: string, chatId: string): Promise<CustomerNote> {
    const client = await this.customerChat(sessionId, chatId)
    const note = await client.getCustomerNote(chatId)
    if (!note) {
      throw new NotFoundError(
        'NOT_FOUND',
        `Chat ${chatId} has no customer note (an account that is not WhatsApp Business has none)`
      )
    }
    return note
  }

  // WhatsApp Web does nothing, and says nothing, on an account without customer notes, so the note
  // is read back: a note that is not there afterwards was not saved. The text is never logged.
  async setCustomerNote(sessionId: string, chatId: string, text: string): Promise<CustomerNote> {
    const client = await this.customerChat(sessionId, chatId)
    await client.addOrEditCustomerNote(chatId, text)
    const saved = await client.getCustomerNote(chatId)
    // WhatsApp may trim the text it keeps, so the edges are not compared
    if (saved?.content.trim() !== text.trim()) {
      throw new WhatsAppError(
        'WHATSAPP_ERROR',
        'WhatsApp did not save the customer note (only WhatsApp Business accounts have them)'
      )
    }
    return saved
  }

  // A note belongs to a customer, so a group or a channel is refused before WhatsApp ignores it
  private async customerChat(sessionId: string, chatId: string): Promise<WhatsAppClientPort> {
    const client = this.sessions.requireReady(sessionId)
    const chat = await client.getChatById(chatId)
    if (chat.isGroup || ('isChannel' in chat && chat.isChannel)) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        'Only a chat with one customer has a note, not a group or a channel',
        { chatId }
      )
    }
    return client
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

  // `unarchiveChat` and `unpinChat` of wwebjs 1.34.7 end in `return false` even when WhatsApp Web did
  // it, so their answer says nothing. The state of the chat afterwards does: the call succeeded when
  // the flag is off (also when it already was: undoing what is not done is not an error).
  private async undone(
    sessionId: string,
    chatId: string,
    call: ChatCall,
    what: string,
    flag: 'archived' | 'pinned'
  ): Promise<void> {
    const client = await this.existing(sessionId, chatId)
    await client[call](chatId)
    // WhatsApp Web may take a moment to show the new state: a few reads before giving up
    for (let read = 1; read <= UNDO_READS; read++) {
      const chat = await client.getChatById(chatId)
      const stillOn =
        flag === 'archived' ? 'archived' in chat && chat.archived : 'pinned' in chat && chat.pinned
      if (!stillOn) return
      if (read < UNDO_READS)
        await new Promise<void>(resolve => setTimeout(resolve, UNDO_READ_PAUSE_MS))
    }
    throw new WhatsAppError('WHATSAPP_ERROR', `WhatsApp did not ${what}`)
  }

  private cancel(key: string): void {
    const timer = this.countdowns.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.countdowns.delete(key)
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error)
