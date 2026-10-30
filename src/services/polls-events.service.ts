import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError, ValidationError, WhatsAppError } from '../common/errors.js'
import type { MessageDto, PollVoteDto } from '../types/dto.js'
import type { EditEventBody } from '../types/polls-events.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

// The enum of wwebjs names a scheduled event `scheduled_event_creation`, and its own sender writes
// `event_creation`; either can be what a stored event carries
const EVENT_TYPES = ['scheduled_event_creation', 'event_creation'] as const

// Polls, scheduled events and group invites, which arrive as messages: each operation is a call to
// the session's client on a message that already exists.
@Injectable()
export class PollsEventsService {
  constructor(@Inject(SessionManager) private readonly sessions: SessionManager) {}

  async pollVotes(sessionId: string, messageId: string): Promise<PollVoteDto[]> {
    const client = this.sessions.requireReady(sessionId)
    await this.messageOfType(client, messageId, ['poll_creation'], 'a poll')
    return client.getPollVotes(messageId)
  }

  async vote(sessionId: string, messageId: string, selectedOptions: string[]): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const poll = await this.messageOfType(client, messageId, ['poll_creation'], 'a poll')
    // WhatsApp Web ignores a name that matches no option, and a vote with none removes the vote
    const unknown = selectedOptions.filter(name => !(poll.pollOptions ?? []).includes(name))
    if (unknown.length > 0) {
      throw new ValidationError('VALIDATION_ERROR', 'The poll has no option with that name', {
        unknownOptions: unknown
      })
    }
    return client.vote(messageId, selectedOptions)
  }

  async respondToEvent(sessionId: string, messageId: string, response: number): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    await this.messageOfType(client, messageId, EVENT_TYPES, 'an event')
    // wwebjs answers false when the message vanished between the check and the call
    if (!(await client.sendResponseToScheduledEvent(response, messageId))) {
      throw new NotFoundError('NOT_FOUND', `Message ${messageId} does not exist`)
    }
  }

  async editEvent(sessionId: string, messageId: string, body: EditEventBody): Promise<MessageDto> {
    const client = this.sessions.requireReady(sessionId)
    const event = await this.messageOfType(client, messageId, EVENT_TYPES, 'an event')
    if (!event.fromMe) {
      throw new WhatsAppError(
        'WHATSAPP_ERROR',
        'Only an event created by the account can be edited'
      )
    }
    const edited = await client.editScheduledEvent(messageId, {
      type: 'event',
      name: body.name,
      startTime: new Date(body.startTime),
      ...(body.endTime !== undefined && { endTime: new Date(body.endTime) }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.location !== undefined && { location: body.location }),
      ...(body.callType !== undefined && { callType: body.callType }),
      ...(body.isEventCanceled !== undefined && { isEventCanceled: body.isEventCanceled })
    })
    if (edited === null) {
      throw new WhatsAppError(
        'WHATSAPP_ERROR',
        'WhatsApp did not edit the event: a canceled event cannot be edited again'
      )
    }
    return edited
  }

  async acceptGroupInvite(sessionId: string, messageId: string): Promise<{ status: number }> {
    const client = this.sessions.requireReady(sessionId)
    const invite = (await client.getMessageById(messageId))?.inviteV4
    if (invite === undefined) {
      throw new NotFoundError('NOT_FOUND', `Message ${messageId} carries no group invite`)
    }
    if (invite.inviteCodeExp === 0) {
      throw new ValidationError('VALIDATION_ERROR', 'The group invite has expired', {
        messageId
      })
    }
    return client.acceptGroupV4Invite(invite)
  }

  // 404 for a message that does not exist, 400 for one of another type (wwebjs throws a string)
  private async messageOfType(
    client: ReturnType<SessionManager['requireReady']>,
    messageId: string,
    types: readonly string[],
    what: string
  ): Promise<MessageDto> {
    const message = await client.getMessageById(messageId)
    if (message === null)
      throw new NotFoundError('NOT_FOUND', `Message ${messageId} does not exist`)
    if (!types.includes(message.type)) {
      throw new ValidationError('VALIDATION_ERROR', `Message ${messageId} is not ${what}`, {
        type: message.type
      })
    }
    return message
  }
}
