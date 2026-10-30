import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile
} from '@nestjs/common'
import { ApiAcceptedResponse, ApiBody, ApiOkResponse, ApiProduces } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { ZodResponse, ZodValidationPipe } from 'nestjs-zod'

import { AppError, type ErrorCode, ValidationError } from '../../common/errors.js'
import { MessageSendService, type SendResult } from '../../services/message-send.service.js'
import { MessagesService } from '../../services/messages.service.js'
import {
  DeleteMessageQueryDto,
  EditMessageBodyDto,
  ForwardBodyDto,
  IdempotencyKeyHeader,
  MessageContactsDto,
  MessageGroupsDto,
  MessageInfoResponseDto,
  MessageListDto,
  MessageResponseDto,
  OrderResponseDto,
  PaymentResponseDto,
  PinBodyDto,
  ReactBodyDto,
  ReactionsDto,
  ReplyMessageBody,
  SearchMessagesQueryDto,
  SendJobDto,
  SendMessageBody,
  SendQueryDto,
  SessionJobParamsDto,
  SessionMessageParamsDto,
  StoredMessagesDto,
  StoredMessagesQueryDto
} from '../../types/messages.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import { requestSchemaOf } from '../request-schema.js'
import { WaOperation } from '../wa-operation.decorator.js'

const MESSAGE_ID = 'false_5215500000001@c.us_3EB0C767D0F2A2B91F42'
const MESSAGE_EXAMPLE = {
  id: MESSAGE_ID,
  chatId: '5215500000001@c.us',
  sentAt: '2026-01-01T00:00:00.000Z',
  receivedAt: '2026-01-01T00:00:01.000Z',
  ack: 1,
  deviceType: 'android',
  body: 'Hola, tu pedido va en camino',
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
  type: 'chat'
}
const SEND_REQUEST = { to: '+52 55 0000 0001', type: 'text', body: 'Hola, tu pedido va en camino' }

const ROUTE: ErrorCode[] = ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE']
const ON_MESSAGE: ErrorCode[] = [...ROUTE, 'NOT_FOUND', 'SESSION_NOT_READY', 'WHATSAPP_ERROR']
const SEND_ERRORS: ErrorCode[] = [
  ...ROUTE,
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'MEDIA_FETCH_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
  'NUMBER_NOT_ON_WHATSAPP',
  'POLICY_BLOCKED',
  'DUPLICATE_CONTENT',
  'RECIPIENT_SUPPRESSED',
  'RECIPIENT_UNREACHABLE',
  'POLICY_DELAY_EXCEEDED',
  'SESSION_NOT_READY',
  'UNKNOWN_OUTCOME',
  'ACK_ERROR',
  'WHATSAPP_ERROR',
  'WHATSAPP_TIMEOUT'
]

// Shown by a browser without running anything; the rest of what a sender can attach is downloaded
const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'audio/ogg',
  'audio/mpeg',
  'application/pdf'
])

const idempotencyKeyOf = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined
  const parsed = IdempotencyKeyHeader.safeParse(header)
  if (!parsed.success) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      'The Idempotency-Key header must have 1 to 128 characters',
      { field: 'Idempotency-Key' }
    )
  }
  return parsed.data
}

// The messages of a session: sending (TDD §6.8) and what can be read or done to one message.
// Sending is asynchronous by nature: the answer is 201 with the message when it went out within
// SEND_SYNC_TIMEOUT_MS, and 202 with the job when it did not (or `wait=false`).
@Controller('v1/sessions')
export class MessagesController {
  constructor(
    @Inject(MessageSendService) private readonly sender: MessageSendService,
    @Inject(MessagesService) private readonly messages: MessagesService
  ) {}

  // ---- Sending ---------------------------------------------------------------------------------

  @Post(':sessionId/messages')
  @ZodResponse({ status: HttpStatus.CREATED, type: SendJobDto })
  @ApiAcceptedResponse({ type: SendJobDto, description: 'Queued; the outcome comes as an event' })
  @ApiBody({ schema: requestSchemaOf(SendMessageBody) })
  @WaOperation({
    id: 'messages.send',
    scope: 'send',
    summary: 'Send a message',
    description:
      'Sends text, media, a location, contacts, a poll, an event or a group invite. `to` is a phone number or a WhatsApp id. The message goes through the send queue of the session, the send policy and the pacing, so it may wait. By default the call waits up to SEND_SYNC_TIMEOUT_MS and answers 201 with the message; if the send is still queued by then, or with `wait=false`, it answers 202 with the job, whose result arrives as `message_sent` or `message_failed` and at `GET …/send-jobs/:jobId`. Send an `Idempotency-Key` (up to 128 characters) to make a retry safe: the same key with the same request returns the first result, with another request it is a 422. `media.url` is downloaded by the gateway (public hosts only, MAX_MEDIA_BYTES). A body can be up to 40 MiB.',
    errors: SEND_ERRORS,
    examples: {
      request: SEND_REQUEST,
      response: { jobId: 'idem-3f2a', status: 'sent', message: MESSAGE_EXAMPLE }
    },
    wwebjs: ['Client.sendMessage', 'Chat.sendMessage']
  })
  async send(
    @Param() { sessionId }: SessionIdParamsDto,
    @Query() { wait }: SendQueryDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(SendMessageBody)) body: SendMessageBody,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<SendJobDto> {
    const result = await this.sender.send(
      { sessionId, wait, idempotencyKey: idempotencyKeyOf(idempotencyKey) },
      body
    )
    return this.answer(result, reply)
  }

  @Post(':sessionId/messages/:messageId/reply')
  @ZodResponse({ status: HttpStatus.CREATED, type: SendJobDto })
  @ApiAcceptedResponse({ type: SendJobDto, description: 'Queued; the outcome comes as an event' })
  @ApiBody({ schema: requestSchemaOf(ReplyMessageBody) })
  @WaOperation({
    id: 'messages.reply',
    scope: 'send',
    summary: 'Reply to a message',
    description:
      'A send that quotes the message. It takes the same body as `messages.send`, except that `to` is optional: without it the reply goes to the chat of the message. Waiting, the 202 answer, idempotency and the 40 MiB body limit are the same.',
    errors: SEND_ERRORS,
    examples: {
      request: { type: 'text', body: 'Gracias por tu mensaje' },
      response: { jobId: 'idem-3f2a', status: 'sent', message: MESSAGE_EXAMPLE }
    },
    wwebjs: ['Message.reply']
  })
  async reply(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Query() { wait }: SendQueryDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(ReplyMessageBody)) body: ReplyMessageBody,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<SendJobDto> {
    const result = await this.sender.reply(
      { sessionId, wait, idempotencyKey: idempotencyKeyOf(idempotencyKey) },
      messageId,
      body
    )
    return this.answer(result, reply)
  }

  @Get(':sessionId/send-jobs/:jobId')
  @ZodResponse({ type: SendJobDto })
  @WaOperation({
    id: 'messages.sendJob',
    scope: 'read',
    summary: 'Read a send job',
    description:
      'Where a send is: `queued`, `active`, `sent` (with the message) or `failed` (with the error). A job is kept for a few days after it ends.',
    errors: [...ROUTE, 'NOT_FOUND'],
    examples: {
      request: null,
      response: { jobId: 'idem-3f2a', status: 'sent', message: MESSAGE_EXAMPLE }
    },
    wwebjs: [],
    gateway: true
  })
  sendJob(@Param() { sessionId, jobId }: SessionJobParamsDto): Promise<SendJobDto> {
    return this.messages.sendJob(sessionId, jobId)
  }

  // ---- Reading ---------------------------------------------------------------------------------

  @Get(':sessionId/messages/search')
  @ZodResponse({ type: MessageListDto })
  @WaOperation({
    id: 'messages.search',
    scope: 'read',
    summary: 'Search messages',
    description:
      'Searches the messages WhatsApp Web has loaded for the text, in every chat or in one. The session must be ready.',
    errors: ON_MESSAGE,
    examples: { request: null, response: { items: [MESSAGE_EXAMPLE] } },
    wwebjs: ['Client.searchMessages']
  })
  async search(
    @Param() { sessionId }: SessionIdParamsDto,
    @Query() { query, chatId, limit, page }: SearchMessagesQueryDto
  ): Promise<MessageListDto> {
    return {
      items: await this.messages.search(sessionId, query, {
        limit,
        page,
        ...(chatId !== undefined && { chatId })
      })
    }
  }

  @Get(':sessionId/stored-messages')
  @ZodResponse({ type: StoredMessagesDto })
  @WaOperation({
    id: 'messages.stored',
    scope: 'read',
    summary: 'Read the messages the gateway stored',
    description:
      'The messages the gateway saw, from its own database (retention: MESSAGE_RETENTION_DAYS), newest first by the time the sender wrote them. Page with `cursor`: take `nextCursor` of one page as the `cursor` of the next, and stop when it is null. A page can come back with no items and a cursor.',
    errors: [...ROUTE, 'NOT_FOUND'],
    examples: { request: null, response: { items: [MESSAGE_EXAMPLE], nextCursor: null } },
    wwebjs: [],
    gateway: true
  })
  stored(
    @Param() { sessionId }: SessionIdParamsDto,
    @Query() query: StoredMessagesQueryDto
  ): Promise<StoredMessagesDto> {
    return this.messages.stored(sessionId, query)
  }

  @Get(':sessionId/messages/:messageId')
  @ZodResponse({ type: MessageResponseDto })
  @WaOperation({
    id: 'messages.get',
    scope: 'read',
    summary: 'Read a message',
    description: 'The message as WhatsApp Web has it. The session must be ready.',
    errors: ON_MESSAGE,
    examples: { request: null, response: MESSAGE_EXAMPLE },
    wwebjs: ['Client.getMessageById']
  })
  get(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<MessageResponseDto> {
    return this.messages.get(sessionId, messageId)
  }

  @Get(':sessionId/messages/:messageId/media')
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'The file', schema: { type: 'string', format: 'binary' } })
  @WaOperation({
    id: 'messages.media',
    scope: 'read',
    summary: 'Download the media of a message',
    description:
      'The file of an image, video, audio, document or sticker, with its own content type. Answers 404 when WhatsApp no longer has it.',
    errors: ON_MESSAGE,
    examples: { request: null, response: null },
    wwebjs: ['Message.downloadMedia']
  })
  // The type travels with the file, so an error keeps its JSON content type. The sender of a message
  // chooses its type and its bytes, so only formats a browser shows without running anything are
  // served inline; everything else is a download of opaque bytes, and the response is sandboxed.
  async media(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<StreamableFile> {
    const media = await this.messages.media(sessionId, messageId)
    const inline = INLINE_MEDIA_TYPES.has(media.mimetype)
    const filename = media.filename?.replace(/[^\w.\- ]/g, '_')
    void reply
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
    return new StreamableFile(Buffer.from(media.data, 'base64'), {
      type: inline ? media.mimetype : 'application/octet-stream',
      disposition: `${inline ? 'inline' : 'attachment'}${filename ? `; filename="${filename}"` : ''}`
    })
  }

  @Get(':sessionId/messages/:messageId/quoted')
  @ZodResponse({ type: MessageResponseDto })
  @WaOperation({
    id: 'messages.quoted',
    scope: 'read',
    summary: 'Read the message a message replies to',
    description: 'Answers 404 when the message quotes nothing.',
    errors: ON_MESSAGE,
    examples: { request: null, response: MESSAGE_EXAMPLE },
    wwebjs: ['Message.getQuotedMessage']
  })
  quoted(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<MessageResponseDto> {
    return this.messages.quoted(sessionId, messageId)
  }

  @Get(':sessionId/messages/:messageId/mentions')
  @ZodResponse({ type: MessageContactsDto })
  @WaOperation({
    id: 'messages.mentions',
    scope: 'read',
    summary: 'Read the contacts a message mentions',
    description: 'The contacts tagged in the message.',
    errors: ON_MESSAGE,
    examples: { request: null, response: { items: [] } },
    wwebjs: ['Message.getMentions']
  })
  async mentions(
    @Param() { sessionId, messageId }: SessionMessageParamsDto
  ): Promise<MessageContactsDto> {
    return { items: await this.messages.mentions(sessionId, messageId) }
  }

  @Get(':sessionId/messages/:messageId/group-mentions')
  @ZodResponse({ type: MessageGroupsDto })
  @WaOperation({
    id: 'messages.groupMentions',
    scope: 'read',
    summary: 'Read the groups a message mentions',
    description: 'The groups tagged in the message.',
    errors: ON_MESSAGE,
    examples: { request: null, response: { items: [] } },
    wwebjs: ['Message.getGroupMentions']
  })
  async groupMentions(
    @Param() { sessionId, messageId }: SessionMessageParamsDto
  ): Promise<MessageGroupsDto> {
    return { items: await this.messages.groupMentions(sessionId, messageId) }
  }

  @Get(':sessionId/messages/:messageId/info')
  @ZodResponse({ type: MessageInfoResponseDto })
  @WaOperation({
    id: 'messages.info',
    scope: 'read',
    summary: 'Read the delivery receipts of a message',
    description:
      'Who received, played and read the message, and when. Only for your own messages; answers 404 otherwise.',
    errors: ON_MESSAGE,
    examples: {
      request: null,
      response: {
        delivery: [],
        deliveryRemaining: 0,
        played: [],
        playedRemaining: 0,
        read: [],
        readRemaining: 0
      }
    },
    wwebjs: ['Message.getInfo']
  })
  info(
    @Param() { sessionId, messageId }: SessionMessageParamsDto
  ): Promise<MessageInfoResponseDto> {
    return this.messages.info(sessionId, messageId)
  }

  @Get(':sessionId/messages/:messageId/order')
  @ZodResponse({ type: OrderResponseDto })
  @WaOperation({
    id: 'messages.order',
    scope: 'read',
    summary: 'Read the order of an order message',
    description: 'The products and totals of a message that carries an order.',
    errors: ON_MESSAGE,
    examples: {
      request: null,
      response: { products: [], subtotal: '0', total: '0', currency: 'MXN', createdAt: 1767225600 }
    },
    wwebjs: ['Message.getOrder']
  })
  order(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<OrderResponseDto> {
    return this.messages.order(sessionId, messageId)
  }

  @Get(':sessionId/messages/:messageId/payment')
  @ZodResponse({ type: PaymentResponseDto })
  @WaOperation({
    id: 'messages.payment',
    scope: 'read',
    summary: 'Read the payment of a payment message',
    description: 'The amount and status of a message that carries a payment.',
    errors: ON_MESSAGE,
    examples: {
      request: null,
      response: {
        id: MESSAGE_ID,
        paymentCurrency: 'MXN',
        paymentAmount1000: 100000,
        paymentMessageReceiverJid: '5215500000001@c.us',
        paymentTransactionTimestamp: 1767225600,
        paymentStatus: 1,
        paymentTxnStatus: 1,
        paymentNote: ''
      }
    },
    wwebjs: ['Message.getPayment']
  })
  payment(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<PaymentResponseDto> {
    return this.messages.payment(sessionId, messageId)
  }

  @Get(':sessionId/messages/:messageId/reactions')
  @ZodResponse({ type: ReactionsDto })
  @WaOperation({
    id: 'messages.reactions',
    scope: 'read',
    summary: 'Read the reactions to a message',
    description: 'The reactions grouped by emoji, with who sent each.',
    errors: ON_MESSAGE,
    examples: { request: null, response: { items: [] } },
    wwebjs: ['Message.getReactions']
  })
  async reactions(
    @Param() { sessionId, messageId }: SessionMessageParamsDto
  ): Promise<ReactionsDto> {
    return { items: await this.messages.reactions(sessionId, messageId) }
  }

  // ---- Actions ---------------------------------------------------------------------------------

  @Post(':sessionId/messages/:messageId/react')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.react',
    scope: 'send',
    summary: 'React to a message',
    description: 'Reacts with an emoji; an empty `reaction` removes the reaction.',
    errors: ON_MESSAGE,
    examples: { request: { reaction: '👍' }, response: null },
    wwebjs: ['Client.sendReaction', 'Message.react']
  })
  react(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Body() { reaction }: ReactBodyDto
  ): Promise<void> {
    return this.messages.react(sessionId, messageId, reaction)
  }

  @Post(':sessionId/messages/:messageId/forward')
  @ZodResponse({ status: HttpStatus.CREATED, type: SendJobDto })
  @ApiAcceptedResponse({ type: SendJobDto, description: 'Queued; the outcome comes as an event' })
  @WaOperation({
    id: 'messages.forward',
    scope: 'send',
    summary: 'Forward a message',
    description:
      'Forwards the message to a chat (a phone number or a WhatsApp id). It is a send like any other: it goes through the send queue, the send policy and the pacing, and takes `?wait`, `Idempotency-Key` and the 201/202 answers of `messages.send`. WhatsApp does not say which message the forward created, so the answer is `{ jobId, status: "sent" }` without a `message`.',
    errors: SEND_ERRORS,
    examples: {
      request: { chatId: '5215500000003@c.us' },
      response: { jobId: 'idem-3f2a', status: 'sent' }
    },
    wwebjs: ['Message.forward']
  })
  async forward(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Query() { wait }: SendQueryDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() { chatId }: ForwardBodyDto,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<SendJobDto> {
    const result = await this.sender.forward(
      { sessionId, wait, idempotencyKey: idempotencyKeyOf(idempotencyKey) },
      messageId,
      chatId
    )
    return this.answer(result, reply)
  }

  @Post(':sessionId/messages/:messageId/star')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.star',
    scope: 'manage',
    summary: 'Star a message',
    description: 'Adds the message to the starred messages of the account.',
    errors: ON_MESSAGE,
    examples: { request: null, response: null },
    wwebjs: ['Message.star']
  })
  star(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<void> {
    return this.messages.star(sessionId, messageId)
  }

  @Post(':sessionId/messages/:messageId/unstar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.unstar',
    scope: 'manage',
    summary: 'Unstar a message',
    description: 'Removes the message from the starred messages of the account.',
    errors: ON_MESSAGE,
    examples: { request: null, response: null },
    wwebjs: ['Message.unstar']
  })
  unstar(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<void> {
    return this.messages.unstar(sessionId, messageId)
  }

  @Post(':sessionId/messages/:messageId/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.pin',
    scope: 'manage',
    summary: 'Pin a message',
    description:
      'Pins the message in its chat for 1 day (86400), 7 days (604800) or 30 days (2592000 seconds).',
    errors: ON_MESSAGE,
    examples: { request: { duration: 604800 }, response: null },
    wwebjs: ['Message.pin']
  })
  pin(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Body() { duration }: PinBodyDto
  ): Promise<void> {
    return this.messages.pin(sessionId, messageId, duration)
  }

  @Post(':sessionId/messages/:messageId/unpin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.unpin',
    scope: 'manage',
    summary: 'Unpin a message',
    description: 'Removes the pin of the message.',
    errors: ON_MESSAGE,
    examples: { request: null, response: null },
    wwebjs: ['Message.unpin']
  })
  unpin(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<void> {
    return this.messages.unpin(sessionId, messageId)
  }

  @Patch(':sessionId/messages/:messageId')
  @ZodResponse({ type: MessageResponseDto })
  @WaOperation({
    id: 'messages.edit',
    scope: 'send',
    summary: 'Edit a message',
    description:
      'Changes the text of one of your own messages. WhatsApp allows it for a limited time after sending; otherwise the call fails with WHATSAPP_ERROR.',
    errors: ON_MESSAGE,
    examples: { request: { body: 'Hola, tu pedido llega hoy' }, response: MESSAGE_EXAMPLE },
    wwebjs: ['Message.edit']
  })
  edit(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Body() body: EditMessageBodyDto
  ): Promise<MessageResponseDto> {
    return this.messages.edit(sessionId, messageId, body)
  }

  @Delete(':sessionId/messages/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.delete',
    scope: 'manage',
    summary: 'Delete a message',
    description:
      'Deletes the message for the account, or for everyone in the chat with `everyone=true` (WhatsApp limits that to recent messages of your own). `clearMedia=true` also removes the downloaded file.',
    errors: ON_MESSAGE,
    examples: { request: null, response: null },
    wwebjs: ['Message.delete']
  })
  delete(
    @Param() { sessionId, messageId }: SessionMessageParamsDto,
    @Query() options: DeleteMessageQueryDto
  ): Promise<void> {
    return this.messages.delete(sessionId, messageId, options)
  }

  @Delete(':sessionId/status-messages/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'messages.revokeStatus',
    scope: 'manage',
    summary: 'Delete a status you posted',
    description: 'Revokes a status message (a story) of the account.',
    errors: ON_MESSAGE,
    examples: { request: null, response: null },
    wwebjs: ['Client.revokeStatusMessage']
  })
  revokeStatus(@Param() { sessionId, messageId }: SessionMessageParamsDto): Promise<void> {
    return this.messages.revokeStatus(sessionId, messageId)
  }

  // ---- Helpers ---------------------------------------------------------------------------------

  // 201 with the message, 202 with the job, or the error the send ended with
  private answer(result: SendResult, reply: FastifyReply): SendJobDto {
    if (result.replayed) void reply.header('idempotent-replayed', 'true')
    const { jobId, outcome } = result
    if (outcome === undefined) {
      void reply.status(HttpStatus.ACCEPTED)
      return { jobId, status: 'queued' }
    }
    if (!outcome.ok) {
      throw new AppError(outcome.error.code, outcome.error.message, outcome.error.details)
    }
    return {
      jobId,
      status: 'sent',
      ...(outcome.message !== undefined && { message: outcome.message })
    }
  }
}
