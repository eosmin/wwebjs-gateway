import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError, ValidationError, WhatsAppError } from '../common/errors.js'
import {
  REACTION_SETTINGS,
  type AdminInviteBody,
  type CreateChannelBody,
  type ReactionSettingBody,
  type SearchChannelsQuery,
  type TransferOwnershipBody,
  type UnsubscribeBody
} from '../types/channels.dto.js'
import type { ChannelDto, MessageDto } from '../types/dto.js'
import type { MediaSource } from '../types/messages.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type {
  AnyChatDto,
  ChannelSubscriber,
  CreateChannelResult,
  OutboundMedia
} from '../whatsapp/whatsapp-client.port.js'

import { MediaResolverService } from './media-resolver.service.js'

// A key with no value is left out, so that wwebjs applies its own default
const compact = <T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }

const isChannel = (chat: AnyChatDto): chat is ChannelDto =>
  'isChannel' in chat && chat.isChannel === true

// What the channels routes do: reads, the changes to one channel, its admins and its posts' history;
// each one a call to the session's client. Posting goes through the send queue (MessageSendService).
@Injectable()
export class ChannelsService {
  constructor(
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(MediaResolverService) private readonly media: MediaResolverService
  ) {}

  // ---- Reads -----------------------------------------------------------------------------------

  list(sessionId: string): Promise<ChannelDto[]> {
    return this.sessions.requireReady(sessionId).getChannels()
  }

  byInviteCode(sessionId: string, inviteCode: string): Promise<ChannelDto> {
    return this.sessions.requireReady(sessionId).getChannelByInviteCode(inviteCode)
  }

  search(sessionId: string, query: SearchChannelsQuery): Promise<ChannelDto[]> {
    return this.sessions.requireReady(sessionId).searchChannels(compact(query))
  }

  async get(sessionId: string, channelId: string): Promise<ChannelDto> {
    const chat = await this.sessions.requireReady(sessionId).getChatById(channelId)
    if (!isChannel(chat)) throw new NotFoundError('CHAT_NOT_FOUND', 'The chat is not a channel')
    return chat
  }

  subscribers(sessionId: string, channelId: string, limit: number): Promise<ChannelSubscriber[]> {
    return this.sessions.requireReady(sessionId).getChannelSubscribers(channelId, limit)
  }

  messages(
    sessionId: string,
    channelId: string,
    options: { limit: number; fromMe?: boolean | undefined }
  ): Promise<MessageDto[]> {
    return this.sessions.requireReady(sessionId).fetchChannelMessages(channelId, compact(options))
  }

  // ---- Create, follow and delete ---------------------------------------------------------------

  // wwebjs answers a failure with a text instead of throwing
  async create(
    sessionId: string,
    { name, description, picture }: CreateChannelBody
  ): Promise<CreateChannelResult> {
    const client = this.sessions.requireReady(sessionId)
    const resolved = picture === undefined ? undefined : await this.image(sessionId, picture)
    const result = await client.createChannel(name, compact({ description, picture: resolved }))
    if (typeof result === 'string') {
      throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp did not create the channel', {
        reason: result
      })
    }
    return result
  }

  async delete(sessionId: string, channelId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).deleteChannel(channelId),
      'delete the channel'
    )
  }

  async subscribe(sessionId: string, channelId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).subscribeToChannel(channelId),
      'subscribe to the channel'
    )
  }

  async unsubscribe(sessionId: string, channelId: string, options: UnsubscribeBody): Promise<void> {
    this.assertDone(
      await this.sessions
        .requireReady(sessionId)
        .unsubscribeFromChannel(channelId, compact(options)),
      'unsubscribe from the channel'
    )
  }

  // ---- Changes ---------------------------------------------------------------------------------

  // The name first, then the description: WhatsApp has no call that sets both, so a failure of the
  // second leaves the first applied; the error says which ones were applied
  async update(
    sessionId: string,
    channelId: string,
    changes: { name?: string | undefined; description?: string | undefined }
  ): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const applied: string[] = []
    if (changes.name !== undefined) {
      this.assertDone(
        await client.setChannelSubject(channelId, changes.name),
        'change the name',
        'name',
        applied
      )
      applied.push('name')
    }
    if (changes.description !== undefined) {
      this.assertDone(
        await client.setChannelDescription(channelId, changes.description),
        'change the description',
        'description',
        applied
      )
    }
  }

  async setPicture(sessionId: string, channelId: string, source: MediaSource): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const picture = await this.image(sessionId, source)
    this.assertDone(
      await client.setChannelProfilePicture(channelId, picture),
      'change the channel picture'
    )
  }

  async setReactionSetting(
    sessionId: string,
    channelId: string,
    { setting }: ReactionSettingBody
  ): Promise<void> {
    this.assertDone(
      await this.sessions
        .requireReady(sessionId)
        .setChannelReactionSetting(channelId, REACTION_SETTINGS[setting]),
      'change the reactions'
    )
  }

  async mute(sessionId: string, channelId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).muteChannel(channelId),
      'mute the channel'
    )
  }

  async unmute(sessionId: string, channelId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).unmuteChannel(channelId),
      'unmute the channel'
    )
  }

  // ---- Admins ----------------------------------------------------------------------------------

  async inviteAdmin(
    sessionId: string,
    channelId: string,
    { userId, comment }: AdminInviteBody
  ): Promise<void> {
    this.assertDone(
      await this.sessions
        .requireReady(sessionId)
        .sendChannelAdminInvite(userId, channelId, compact({ comment })),
      'send the admin invitation'
    )
  }

  async acceptAdminInvite(sessionId: string, channelId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).acceptChannelAdminInvite(channelId),
      'accept the admin invitation'
    )
  }

  async revokeAdminInvite(sessionId: string, channelId: string, userId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).revokeChannelAdminInvite(channelId, userId),
      'revoke the admin invitation'
    )
  }

  async demoteAdmin(sessionId: string, channelId: string, userId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).demoteChannelAdmin(channelId, userId),
      'demote the admin'
    )
  }

  async transferOwnership(
    sessionId: string,
    channelId: string,
    { newOwnerId, shouldDismissSelfAsAdmin }: TransferOwnershipBody
  ): Promise<void> {
    this.assertDone(
      await this.sessions
        .requireReady(sessionId)
        .transferChannelOwnership(channelId, newOwnerId, compact({ shouldDismissSelfAsAdmin })),
      'transfer the ownership'
    )
  }

  // The source of a picture, checked to be an image before WhatsApp sees it
  private async image(sessionId: string, source: MediaSource): Promise<OutboundMedia> {
    const picture = await this.media.resolve(sessionId, source)
    if (!picture.mimetype.toLowerCase().startsWith('image/')) {
      throw new ValidationError('VALIDATION_ERROR', 'The channel picture must be an image', {
        field: 'source',
        mimetype: picture.mimetype
      })
    }
    return picture
  }

  // A call that answers false when WhatsApp Web did not do it; `failed` and `applied` tell the
  // caller how far a multi-call change got
  private assertDone(done: boolean, what: string, failed?: string, applied: string[] = []): void {
    if (done) return
    throw new WhatsAppError(
      'WHATSAPP_ERROR',
      `WhatsApp did not ${what}`,
      failed === undefined ? undefined : { failed, applied: [...applied] }
    )
  }
}
