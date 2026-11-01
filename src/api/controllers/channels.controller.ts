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
  Put,
  Query,
  Res
} from '@nestjs/common'
import { ApiAcceptedResponse, ApiBody } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { ZodResponse, ZodValidationPipe } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { ChannelsService } from '../../services/channels.service.js'
import { MessageSendService } from '../../services/message-send.service.js'
import {
  AdminInviteBodyDto,
  ChannelListDto,
  ChannelMessageListDto,
  ChannelMessagesQueryDto,
  ChannelPostBody,
  ChannelResponseDto,
  CreateChannelBodyDto,
  CreatedChannelDto,
  ReactionSettingBodyDto,
  SearchChannelsQueryDto,
  SessionChannelInviteParamsDto,
  SessionChannelParamsDto,
  SessionChannelUserParamsDto,
  SetChannelPictureBodyDto,
  SubscriberListDto,
  SubscribersQueryDto,
  TransferOwnershipBodyDto,
  UnsubscribeBodyDto,
  UpdateChannelBodyDto
} from '../../types/channels.dto.js'
import type { ChannelDto } from '../../types/dto.js'
import { SendJobDto, SendQueryDto } from '../../types/messages.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import { requestSchemaOf } from '../request-schema.js'
import { WaOperation } from '../wa-operation.decorator.js'

import { SEND_ERRORS, idempotencyKeyOf, sendAnswer } from './send-answer.js'

const ON_SESSION: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'SESSION_NOT_READY',
  'WHATSAPP_ERROR'
]
const ON_CHANNEL: ErrorCode[] = [...ON_SESSION, 'CHAT_NOT_FOUND']
const ON_PICTURE: ErrorCode[] = [...ON_CHANNEL, 'PAYLOAD_TOO_LARGE', 'MEDIA_FETCH_FAILED']

const CHANNEL_ID = '120363000000000001@newsletter'
const USER_ID = '5215500000001@c.us'
const CHANNEL = {
  id: CHANNEL_ID,
  name: 'Novedades',
  description: 'Avisos de la tienda',
  isChannel: true,
  isGroup: false,
  isReadOnly: false,
  unreadCount: 0,
  timestamp: 1767225600,
  isMuted: false,
  muteExpiration: 0
}
const POST_MESSAGE = {
  id: 'true_120363000000000001@newsletter_3EB0C767D0F2A2B91F42',
  chatId: CHANNEL_ID,
  sentAt: '2026-01-01T00:00:00.000Z',
  receivedAt: '2026-01-01T00:00:01.000Z',
  ack: 1,
  deviceType: 'android',
  body: 'Nueva colección',
  broadcast: false,
  isStatus: false,
  isGif: false,
  isEphemeral: false,
  from: CHANNEL_ID,
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
  to: CHANNEL_ID,
  type: 'chat'
}

// The channels of the account: finding, following and creating them, changing one, its admins and its
// posts. Reading a channel as a chat is `chats.get`, and marking it as seen is `chats.seen`.
@Controller('v1/sessions')
export class ChannelsController {
  constructor(
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(MessageSendService) private readonly sender: MessageSendService
  ) {}

  // The static routes (`by-invite`, `search`) are declared before the ones of `:channelId`

  @Get(':sessionId/channels')
  @ZodResponse({ type: ChannelListDto })
  @WaOperation({
    id: 'channels.list',
    scope: 'read',
    summary: 'List the channels',
    description:
      'The channels the account follows or owns, as WhatsApp Web has them loaded. The same channels as `chats.list` shows, without the other chats.',
    errors: ON_SESSION,
    examples: { request: null, response: { items: [CHANNEL] } },
    wwebjs: [
      'Channel.description',
      'Channel.id',
      'Channel.isChannel',
      'Channel.isGroup',
      'Channel.isMuted',
      'Channel.isReadOnly',
      'Channel.lastMessage',
      'Channel.muteExpiration',
      'Channel.name',
      'Channel.timestamp',
      'Channel.unreadCount',
      'Client.getChannels'
    ]
  })
  async list(@Param() { sessionId }: SessionIdParamsDto): Promise<ChannelListDto> {
    return { items: await this.channels.list(sessionId) }
  }

  @Get(':sessionId/channels/by-invite/:inviteCode')
  @ZodResponse({ type: ChannelResponseDto })
  @WaOperation({
    id: 'channels.byInvite',
    scope: 'read',
    summary: 'Read a channel by its invite code',
    description:
      'The channel of a link (`https://whatsapp.com/channel/<inviteCode>`), without following it. Fails with `WHATSAPP_ERROR` when WhatsApp finds no channel for the code.',
    errors: ON_SESSION,
    examples: { request: null, response: CHANNEL },
    wwebjs: ['Client.getChannelByInviteCode']
  })
  byInvite(@Param() { sessionId, inviteCode }: SessionChannelInviteParamsDto): Promise<ChannelDto> {
    return this.channels.byInviteCode(sessionId, inviteCode)
  }

  @Get(':sessionId/channels/search')
  @ZodResponse({ type: ChannelListDto })
  @WaOperation({
    id: 'channels.search',
    scope: 'read',
    summary: 'Search the directory of channels',
    description:
      'Searches the channels WhatsApp lists, by words in the name and by country. `countryCodes` is one comma-separated value (`MX,US`).',
    errors: ON_SESSION,
    examples: { request: null, response: { items: [CHANNEL] } },
    wwebjs: [
      'Client.searchChannels',
      'SearchChannelsOptions.countryCodes',
      'SearchChannelsOptions.limit',
      'SearchChannelsOptions.searchText',
      'SearchChannelsOptions.skipSubscribedNewsletters',
      'SearchChannelsOptions.view'
    ]
  })
  async search(
    @Param() { sessionId }: SessionIdParamsDto,
    @Query() query: SearchChannelsQueryDto
  ): Promise<ChannelListDto> {
    return { items: await this.channels.search(sessionId, query) }
  }

  @Post(':sessionId/channels')
  @ZodResponse({ status: HttpStatus.CREATED, type: CreatedChannelDto })
  @WaOperation({
    id: 'channels.create',
    scope: 'manage',
    summary: 'Create a channel',
    description:
      'Creates a channel owned by the account. The picture is an image from `base64`, a public `url` or a stored message. Fails with `WHATSAPP_ERROR` when WhatsApp does not create it (the name is taken, or the account cannot own channels).',
    errors: ON_PICTURE,
    examples: {
      request: { name: 'Novedades', description: 'Avisos de la tienda' },
      response: {
        name: 'Novedades',
        channelId: CHANNEL_ID,
        inviteLink: 'https://whatsapp.com/channel/AbCdEfGhIjKlMnOpQrStUv',
        createdAt: 1767225600
      }
    },
    wwebjs: [
      'Client.createChannel',
      'CreateChannelOptions.description',
      'CreateChannelOptions.picture',
      'CreateChannelResult.createdAtTs',
      'CreateChannelResult.inviteLink',
      'CreateChannelResult.nid',
      'CreateChannelResult.title'
    ]
  })
  async create(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() body: CreateChannelBodyDto
  ): Promise<CreatedChannelDto> {
    const { title, nid, inviteLink, createdAtTs } = await this.channels.create(sessionId, body)
    return { name: title, channelId: nid, inviteLink, createdAt: createdAtTs }
  }

  @Get(':sessionId/channels/:channelId')
  @ZodResponse({ type: ChannelResponseDto })
  @WaOperation({
    id: 'channels.get',
    scope: 'read',
    summary: 'Read a channel',
    description:
      'One channel of the session. Answers 404 `CHAT_NOT_FOUND` when the session has no such chat or it is not a channel.',
    errors: ON_CHANNEL,
    examples: { request: null, response: CHANNEL },
    gateway: true,
    wwebjs: []
  })
  get(@Param() { sessionId, channelId }: SessionChannelParamsDto): Promise<ChannelDto> {
    return this.channels.get(sessionId, channelId)
  }

  @Delete(':sessionId/channels/:channelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.delete',
    scope: 'manage',
    summary: 'Delete a channel',
    description:
      'Deletes a channel the account owns, for every subscriber. It cannot be undone. This is the way to delete a channel: `chats.delete` refuses channels. Fails with `WHATSAPP_ERROR` when WhatsApp refuses (the account is not the owner).',
    errors: ON_CHANNEL,
    examples: { request: null, response: null },
    wwebjs: ['Channel.deleteChannel', 'Client.deleteChannel']
  })
  delete(@Param() { sessionId, channelId }: SessionChannelParamsDto): Promise<void> {
    return this.channels.delete(sessionId, channelId)
  }

  @Patch(':sessionId/channels/:channelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.update',
    scope: 'manage',
    summary: 'Change the name or the description',
    description:
      'Sets what is sent: the name first, then the description. WhatsApp has no call that sets both, so a failure of the second leaves the first applied. Fails with `WHATSAPP_ERROR` when WhatsApp refuses (the account is not an admin).',
    errors: ON_CHANNEL,
    examples: { request: { name: 'Novedades VIP', description: 'Avisos' }, response: null },
    wwebjs: ['Channel.setDescription', 'Channel.setSubject']
  })
  update(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Body() body: UpdateChannelBodyDto
  ): Promise<void> {
    return this.channels.update(sessionId, channelId, body)
  }

  @Put(':sessionId/channels/:channelId/picture')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.setPicture',
    scope: 'manage',
    summary: 'Change the picture of a channel',
    description:
      'Sets the picture from inline `base64`, a public `url` or the image of a stored message. Anything that is not an image is a 400. A `url` goes through the SSRF guard and the size cap `MAX_MEDIA_BYTES`; the body of a request is limited to 1 MiB, so a larger image goes by `url`.',
    errors: ON_PICTURE,
    examples: {
      request: { source: { url: 'https://example.com/logo.png' } },
      response: null
    },
    wwebjs: ['Channel.setProfilePicture']
  })
  setPicture(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Body() { source }: SetChannelPictureBodyDto
  ): Promise<void> {
    return this.channels.setPicture(sessionId, channelId, source)
  }

  @Put(':sessionId/channels/:channelId/reaction-setting')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.reactionSetting',
    scope: 'manage',
    summary: 'Choose which reactions a channel allows',
    description:
      '`none` allows no reactions, `basic` the six of WhatsApp (👍 ❤️ 😂 😮 😢 🙏) and `all` any emoji. Needs an admin account.',
    errors: ON_CHANNEL,
    examples: { request: { setting: 'basic' }, response: null },
    wwebjs: ['Channel.setReactionSetting']
  })
  reactionSetting(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Body() body: ReactionSettingBodyDto
  ): Promise<void> {
    return this.channels.setReactionSetting(sessionId, channelId, body)
  }

  @Post(':sessionId/channels/:channelId/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.subscribe',
    scope: 'manage',
    summary: 'Follow a channel',
    description:
      'The account follows the channel. Fails with `WHATSAPP_ERROR` when WhatsApp refuses or finds no such channel.',
    errors: ON_SESSION,
    examples: { request: null, response: null },
    wwebjs: ['Client.subscribeToChannel']
  })
  subscribe(@Param() { sessionId, channelId }: SessionChannelParamsDto): Promise<void> {
    return this.channels.subscribe(sessionId, channelId)
  }

  @Post(':sessionId/channels/:channelId/unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.unsubscribe',
    scope: 'manage',
    summary: 'Stop following a channel',
    description:
      'The account stops following the channel. With `deleteLocalModels` the channel is also removed from the account and becomes a guest membership.',
    errors: ON_SESSION,
    examples: { request: { deleteLocalModels: false }, response: null },
    wwebjs: ['Client.unsubscribeFromChannel', 'UnsubscribeOptions.deleteLocalModels']
  })
  unsubscribe(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Body() body: UnsubscribeBodyDto
  ): Promise<void> {
    return this.channels.unsubscribe(sessionId, channelId, body)
  }

  @Post(':sessionId/channels/:channelId/mute')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.mute',
    scope: 'manage',
    summary: 'Mute a channel',
    description: 'Mutes the notifications of the channel for ever, in the linked account.',
    errors: ON_CHANNEL,
    examples: { request: null, response: null },
    wwebjs: ['Channel.mute']
  })
  mute(@Param() { sessionId, channelId }: SessionChannelParamsDto): Promise<void> {
    return this.channels.mute(sessionId, channelId)
  }

  @Post(':sessionId/channels/:channelId/unmute')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.unmute',
    scope: 'manage',
    summary: 'Unmute a channel',
    description: 'Turns the notifications of the channel on again.',
    errors: ON_CHANNEL,
    examples: { request: null, response: null },
    wwebjs: ['Channel.unmute']
  })
  unmute(@Param() { sessionId, channelId }: SessionChannelParamsDto): Promise<void> {
    return this.channels.unmute(sessionId, channelId)
  }

  @Get(':sessionId/channels/:channelId/subscribers')
  @ZodResponse({ type: SubscriberListDto })
  @WaOperation({
    id: 'channels.subscribers',
    scope: 'read',
    summary: 'List the subscribers of a channel',
    description:
      'The subscribers that are in the contact list of the account (WhatsApp Web does not give the rest), with their role. Needs an admin account.',
    errors: ON_CHANNEL,
    examples: {
      request: null,
      response: {
        items: [
          {
            contact: {
              id: USER_ID,
              number: '5215500000001',
              isBusiness: false,
              isEnterprise: false,
              isGroup: false,
              isMe: false,
              isMyContact: true,
              isUser: true,
              isWAContact: true,
              isBlocked: false
            },
            role: 'subscriber'
          }
        ]
      }
    },
    wwebjs: ['Channel.getSubscribers']
  })
  async subscribers(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Query() { limit }: SubscribersQueryDto
  ): Promise<SubscriberListDto> {
    return { items: await this.channels.subscribers(sessionId, channelId, limit) }
  }

  @Get(':sessionId/channels/:channelId/messages')
  @ZodResponse({ type: ChannelMessageListDto })
  @WaOperation({
    id: 'channels.messages',
    scope: 'read',
    summary: 'Read the posts of a channel',
    description:
      'The latest posts of the channel that WhatsApp Web has loaded, oldest first, up to `limit`. With `fromMe` only the posts the account made (true) or the rest (false).',
    errors: ON_CHANNEL,
    examples: { request: null, response: { items: [POST_MESSAGE] } },
    wwebjs: ['Channel.fetchMessages']
  })
  async messages(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Query() query: ChannelMessagesQueryDto
  ): Promise<ChannelMessageListDto> {
    return { items: await this.channels.messages(sessionId, channelId, query) }
  }

  @Post(':sessionId/channels/:channelId/messages')
  @ZodResponse({ status: HttpStatus.CREATED, type: SendJobDto })
  @ApiAcceptedResponse({ type: SendJobDto, description: 'Queued; the outcome comes as an event' })
  @ApiBody({ schema: requestSchemaOf(ChannelPostBody) })
  @WaOperation({
    id: 'channels.post',
    scope: 'send',
    summary: 'Post to a channel',
    description:
      'Posts text, or one media file with a caption, to a channel the account owns or administers. It is a send like `messages.send`: it goes through the send queue, the send policy and the pacing, answers 201 with the message or 202 with the job (`wait=false` or a long queue), and takes an `Idempotency-Key`. A channel has no typing indicator, so there is no `humanize`. A body can be up to 40 MiB.',
    errors: [...SEND_ERRORS, 'CHAT_NOT_FOUND'],
    examples: {
      request: { type: 'text', body: 'Nueva colección' },
      response: { jobId: 'idem-3f2a', status: 'sent', message: POST_MESSAGE }
    },
    wwebjs: [
      'Channel.sendMessage',
      'MessageSendChannelOptions.caption',
      'MessageSendChannelOptions.media',
      'MessageSendChannelOptions.mentions'
    ]
  })
  async post(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Query() { wait }: SendQueryDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(ChannelPostBody)) body: ChannelPostBody,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<SendJobDto> {
    const result = await this.sender.postToChannel(
      { sessionId, wait, idempotencyKey: idempotencyKeyOf(idempotencyKey) },
      channelId,
      body
    )
    return sendAnswer(result, reply)
  }

  // ---- Admins ----------------------------------------------------------------------------------

  @Post(':sessionId/channels/:channelId/admins/invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.inviteAdmin',
    scope: 'manage',
    summary: 'Invite a user to be an admin',
    description:
      'Sends the user an invitation to administer the channel. Needs the owner account. The invited user accepts it from their own account.',
    errors: ON_CHANNEL,
    examples: { request: { userId: USER_ID, comment: 'Bienvenido' }, response: null },
    wwebjs: ['Channel.sendChannelAdminInvite', 'Client.sendChannelAdminInvite']
  })
  inviteAdmin(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Body() body: AdminInviteBodyDto
  ): Promise<void> {
    return this.channels.inviteAdmin(sessionId, channelId, body)
  }

  @Post(':sessionId/channels/:channelId/admins/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.acceptAdminInvite',
    scope: 'manage',
    summary: 'Accept an invitation to be an admin',
    description:
      'The account accepts the invitation the owner sent and becomes an admin of the channel.',
    errors: ON_CHANNEL,
    examples: { request: null, response: null },
    wwebjs: ['Channel.acceptChannelAdminInvite', 'Client.acceptChannelAdminInvite']
  })
  acceptAdminInvite(@Param() { sessionId, channelId }: SessionChannelParamsDto): Promise<void> {
    return this.channels.acceptAdminInvite(sessionId, channelId)
  }

  @Delete(':sessionId/channels/:channelId/admins/:userId/invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.revokeAdminInvite',
    scope: 'manage',
    summary: 'Revoke an invitation to be an admin',
    description: 'Withdraws the invitation sent to the user. Needs the owner account.',
    errors: ON_CHANNEL,
    examples: { request: null, response: null },
    wwebjs: ['Channel.revokeChannelAdminInvite', 'Client.revokeChannelAdminInvite']
  })
  revokeAdminInvite(
    @Param() { sessionId, channelId, userId }: SessionChannelUserParamsDto
  ): Promise<void> {
    return this.channels.revokeAdminInvite(sessionId, channelId, userId)
  }

  @Post(':sessionId/channels/:channelId/admins/:userId/demote')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.demoteAdmin',
    scope: 'manage',
    summary: 'Remove an admin',
    description: 'The user stops being an admin of the channel. Needs the owner account.',
    errors: ON_CHANNEL,
    examples: { request: null, response: null },
    wwebjs: ['Channel.demoteChannelAdmin', 'Client.demoteChannelAdmin']
  })
  demoteAdmin(
    @Param() { sessionId, channelId, userId }: SessionChannelUserParamsDto
  ): Promise<void> {
    return this.channels.demoteAdmin(sessionId, channelId, userId)
  }

  @Post(':sessionId/channels/:channelId/transfer-ownership')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'channels.transferOwnership',
    scope: 'manage',
    summary: 'Hand the channel to another owner',
    description:
      'Makes an admin the owner of the channel. It cannot be undone by the account unless the new owner hands it back. With `shouldDismissSelfAsAdmin` the account also stops being an admin.',
    errors: ON_CHANNEL,
    examples: { request: { newOwnerId: USER_ID, shouldDismissSelfAsAdmin: false }, response: null },
    wwebjs: [
      'Channel.transferChannelOwnership',
      'Client.transferChannelOwnership',
      'TransferChannelOwnershipOptions.shouldDismissSelfAsAdmin'
    ]
  })
  transferOwnership(
    @Param() { sessionId, channelId }: SessionChannelParamsDto,
    @Body() body: TransferOwnershipBodyDto
  ): Promise<void> {
    return this.channels.transferOwnership(sessionId, channelId, body)
  }
}
