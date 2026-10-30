import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post
} from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { PollsEventsService } from '../../services/polls-events.service.js'
import { MessageResponseDto, SessionMessageParamsDto } from '../../types/messages.dto.js'
import {
  EditEventBodyDto,
  EventResponseBodyDto,
  GroupInviteResultDto,
  PollVotesDto,
  VoteBodyDto
} from '../../types/polls-events.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const ON_MESSAGE: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'SESSION_NOT_READY',
  'WHATSAPP_ERROR'
]

const VOTE_EXAMPLE = {
  voter: '5215500000002@c.us',
  selectedOptions: [{ id: 0, name: 'Martes' }],
  interactedAtTs: 1767225600000,
  parentMessageId: 'false_5215500000001@c.us_3EB0C767D0F2A2B91F42'
}
const EVENT_MESSAGE = {
  id: 'true_5215500000001@c.us_3EB0C767D0F2A2B91F43',
  chatId: '5215500000001@c.us',
  sentAt: '2026-01-01T00:00:00.000Z',
  receivedAt: '2026-01-01T00:00:01.000Z',
  ack: 1,
  deviceType: 'android',
  body: '',
  broadcast: false,
  isStatus: false,
  isGif: false,
  isEphemeral: false,
  from: '5215500000002@c.us',
  fromMe: true,
  hasMedia: false,
  hasQuotedMsg: false,
  hasReaction: false,
  isForwarded: false,
  forwardingScore: 0,
  isStarred: false,
  vCards: [],
  mentionedIds: [],
  groupMentions: [],
  links: [],
  timestamp: 1767225600,
  to: '5215500000001@c.us',
  type: 'scheduled_event_creation'
}

// Polls, scheduled events and group invites: things a message carries that can be answered.
@Controller('v1/sessions')
export class PollsEventsController {
  constructor(@Inject(PollsEventsService) private readonly service: PollsEventsService) {}

  @Get(':sessionId/polls/:messageId/votes')
  @ZodResponse({ type: PollVotesDto })
  @WaOperation({
    id: 'polls.votes',
    scope: 'read',
    summary: 'Read the votes of a poll',
    description:
      'Who voted for what in the poll message. Answers 404 when the message does not exist and 400 when it is not a poll. Votes also arrive as `vote_update` events.',
    errors: ON_MESSAGE,
    examples: { request: null, response: { items: [VOTE_EXAMPLE] } },
    wwebjs: ['Client.getPollVotes']
  })
  async votes(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<PollVotesDto> {
    return { items: await this.service.pollVotes(sessionId, messageId) }
  }

  @Get(':sessionId/messages/:messageId/poll-votes')
  @ZodResponse({ type: PollVotesDto })
  @WaOperation({
    id: 'messages.pollVotes',
    scope: 'read',
    summary: 'Read the votes of a poll message',
    description: 'The same answer as `polls.votes`, from the route of the message.',
    errors: ON_MESSAGE,
    examples: { request: null, response: { items: [VOTE_EXAMPLE] } },
    wwebjs: ['Message.getPollVotes']
  })
  async messageVotes(
    @Param() { sessionId, messageId }: SessionMessageParamsDto
  ): Promise<PollVotesDto> {
    return { items: await this.service.pollVotes(sessionId, messageId) }
  }

  @Post(':sessionId/messages/:messageId/vote')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.vote',
    scope: 'send',
    summary: 'Vote in a poll',
    description:
      'Votes for the options with these names, replacing a previous vote; an empty list removes the vote. Answers 404 when the message does not exist and 400 when it is not a poll or a name matches no option.',
    errors: ON_MESSAGE,
    examples: { request: { selectedOptions: ['Martes'] }, response: null },
    wwebjs: ['Message.vote']
  })
  vote(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Body() { selectedOptions }: VoteBodyDto
  ): Promise<void> {
    return this.service.vote(sessionId, messageId, selectedOptions)
  }

  @Post(':sessionId/events/:messageId/response')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'events.respond',
    scope: 'send',
    summary: 'Answer a scheduled event',
    description:
      'Tells the organizer whether the account goes: 1 going, 2 not going, 3 maybe, 0 removes a previous answer. Answers 404 when the message does not exist and 400 when it is not an event.',
    errors: ON_MESSAGE,
    examples: { request: { response: 1 }, response: null },
    wwebjs: ['Client.sendResponseToScheduledEvent']
  })
  respond(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Body() { response }: EventResponseBodyDto
  ): Promise<void> {
    return this.service.respondToEvent(sessionId, messageId, response)
  }

  @Patch(':sessionId/events/:messageId')
  @ZodResponse({ type: MessageResponseDto })
  @WaOperation({
    id: 'events.edit',
    scope: 'send',
    summary: 'Edit a scheduled event',
    description:
      'Replaces the fields of an event you created; send all of them, since one left out is cleared. `isEventCanceled` cancels it. Answers 404 when the message does not exist and 400 when it is not an event; fails with WHATSAPP_ERROR for an event somebody else created and for one already canceled.',
    errors: ON_MESSAGE,
    examples: {
      request: { name: 'Entrega de pedidos', startTime: '2026-02-01T18:00:00.000Z' },
      response: EVENT_MESSAGE
    },
    wwebjs: ['Message.editScheduledEvent']
  })
  edit(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Body() body: EditEventBodyDto
  ): Promise<MessageResponseDto> {
    return this.service.editEvent(sessionId, messageId, body)
  }

  @Post(':sessionId/messages/:messageId/accept-group-invite')
  @ZodResponse({ status: HttpStatus.OK, type: GroupInviteResultDto })
  @WaOperation({
    id: 'messages.acceptGroupInvite',
    scope: 'manage',
    summary: 'Accept the group invite of a message',
    description:
      'Joins the group of an invite the message carries (a V4 invite sent to the account). Answers 404 when the message does not exist or has no invite, and 400 when the invite has expired.',
    errors: ON_MESSAGE,
    examples: { request: null, response: { status: 200 } },
    wwebjs: ['Client.acceptGroupV4Invite', 'Message.acceptGroupV4Invite']
  })
  acceptGroupInvite(
    @Param() { sessionId, messageId }: SessionMessageParamsDto
  ): Promise<GroupInviteResultDto> {
    return this.service.acceptGroupInvite(sessionId, messageId)
  }
}
