import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError, ValidationError } from '../common/errors.js'
import type { LabelDto } from '../types/dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type { AnyChatDto, WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

// What the labels routes do: reading the labels of the account and the chats that carry them, and
// setting the labels of chats. Labels exist on WhatsApp Business accounts only; the page refuses to
// change them on any other (`WHATSAPP_ERROR`).
//
// WhatsApp Web ignores an id it does not know, so a wrong label or chat id would "work" and change
// nothing. The service checks them first and answers for them.
@Injectable()
export class LabelsService {
  constructor(@Inject(SessionManager) private readonly sessions: SessionManager) {}

  // ---- Reads -----------------------------------------------------------------------------------

  list(sessionId: string): Promise<LabelDto[]> {
    return this.sessions.requireReady(sessionId).getLabels()
  }

  async get(sessionId: string, labelId: string): Promise<LabelDto> {
    const client = this.sessions.requireReady(sessionId)
    await this.requireLabel(client, labelId)
    return client.getLabelById(labelId)
  }

  async chats(sessionId: string, labelId: string): Promise<AnyChatDto[]> {
    const client = this.sessions.requireReady(sessionId)
    await this.requireLabel(client, labelId)
    return client.getChatsByLabelId(labelId)
  }

  // `getChatById` answers 404 CHAT_NOT_FOUND for a chat the page does not have
  async ofChat(sessionId: string, chatId: string): Promise<LabelDto[]> {
    const client = this.sessions.requireReady(sessionId)
    await client.getChatById(chatId)
    return client.getChatLabels(chatId)
  }

  // ---- Actions ---------------------------------------------------------------------------------

  setForChat(sessionId: string, chatId: string, labelIds: string[]): Promise<void> {
    return this.assign(sessionId, labelIds, [chatId])
  }

  // The labels listed end up on every chat, and any other label of those chats is removed
  async assign(sessionId: string, labelIds: string[], chatIds: string[]): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    await this.requireLabels(client, labelIds)
    for (const chatId of chatIds) await client.getChatById(chatId)
    await client.addOrRemoveLabels(labelIds, chatIds)
  }

  // ---- Checks ----------------------------------------------------------------------------------

  private async requireLabel(client: WhatsAppClientPort, labelId: string): Promise<void> {
    const known = await client.getLabels()
    if (!known.some(label => label.id === labelId)) {
      throw new NotFoundError('NOT_FOUND', `Label ${labelId} does not exist`)
    }
  }

  private async requireLabels(client: WhatsAppClientPort, labelIds: string[]): Promise<void> {
    if (labelIds.length === 0) return
    const known = new Set((await client.getLabels()).map(label => label.id))
    const unknown = labelIds.filter(id => !known.has(id))
    if (unknown.length > 0) {
      throw new ValidationError('VALIDATION_ERROR', `Unknown label ids: ${unknown.join(', ')}`)
    }
  }
}
