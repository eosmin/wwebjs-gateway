import { Inject, Injectable } from '@nestjs/common'

import { AppError, NotFoundError, ValidationError } from '../common/errors.js'
import { canonicalJson } from '../common/lib/canonical-json.js'
import { sha256Hex } from '../common/lib/crypto.js'
import { isChannelId } from '../common/lib/wa-id.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { ChannelPostBody } from '../types/channels.dto.js'
import type { ReplyMessageBody, SendMessageBody } from '../types/messages.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type { OutboundContent, SendOptions } from '../whatsapp/whatsapp-client.port.js'

import { HumanizeDefaultsService } from './humanize-defaults.service.js'
import { IdempotentSendService } from './idempotent-send.service.js'
import { MediaResolverService } from './media-resolver.service.js'
import { RecipientResolverService } from './recipient-resolver.service.js'
import { SendPolicyService } from './send-policy.service.js'
import type { NewSendJob, SendJobOutcome } from './send-queue.job.js'

const GROUP_INVITE_BASE = 'https://chat.whatsapp.com/'

// A send as the controller reports it
export interface SendResult {
  jobId: string
  // The outcome when there is one; without it the job is still queued and the controller answers 202
  outcome?: SendJobOutcome
  replayed: boolean
}

export interface SendRequest {
  sessionId: string
  idempotencyKey?: string | undefined
  wait: boolean
}

type AnyBody = SendMessageBody | ReplyMessageBody

// What the duplicate-content guard of the policy reads: the text the recipient will see
function policyTextOf(body: AnyBody): string | undefined {
  switch (body.type) {
    case 'text':
      return body.body
    case 'media':
      return body.caption
    case 'contact':
      return body.vcard
    case 'groupInvite':
      return `${GROUP_INVITE_BASE}${body.inviteCode}`
    default:
      return undefined
  }
}

// The options that exist for every kind of content, mapped 1:1 to MessageSendOptions
function commonOptions(body: AnyBody): SendOptions {
  return {
    ...(body.ignoreQuoteErrors !== undefined && { ignoreQuoteErrors: body.ignoreQuoteErrors }),
    ...(body.mentions !== undefined && { mentions: body.mentions }),
    ...(body.groupMentions !== undefined && { groupMentions: body.groupMentions }),
    ...(body.linkPreview !== undefined && { linkPreview: body.linkPreview }),
    ...(body.parseVCards !== undefined && { parseVCards: body.parseVCards }),
    ...(body.sendSeen !== undefined && { sendSeen: body.sendSeen }),
    ...(body.waitUntilMsgSent !== undefined && { waitUntilMsgSent: body.waitUntilMsgSent })
  }
}

// Validates, resolves the recipient and the media, asks the send policy and queues the send. Every
// send of the API (new message, reply) ends in `IdempotentSendService`, so the worker, the pacing and
// the idempotency are the same for all of them.
@Injectable()
export class MessageSendService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(RecipientResolverService) private readonly recipients: RecipientResolverService,
    @Inject(MediaResolverService) private readonly media: MediaResolverService,
    @Inject(SendPolicyService) private readonly policy: SendPolicyService,
    @Inject(IdempotentSendService) private readonly sender: IdempotentSendService,
    @Inject(HumanizeDefaultsService) private readonly humanizeDefaults: HumanizeDefaultsService
  ) {}

  async send(request: SendRequest, body: SendMessageBody): Promise<SendResult> {
    const hash = this.hashOf(request, { op: 'send', body })
    return (
      (await this.replayOf(request, hash)) ??
      this.submit(request, body, body.to, body.quotedMessageId, hash)
    )
  }

  // A reply is a send quoting the message; without `to` it goes to the chat the message is in
  async reply(
    request: SendRequest,
    messageId: string,
    body: ReplyMessageBody
  ): Promise<SendResult> {
    const hash = this.hashOf(request, { op: 'reply', messageId, body })
    const replay = await this.replayOf(request, hash)
    if (replay) return replay
    const to = body.to ?? (await this.chatOf(request.sessionId, messageId))
    return this.submit(request, body, to, messageId, hash)
  }

  // A post to a channel is a send like any other: same queue, policy, pacing and idempotency. Only
  // text and one media file can be posted, and a channel has no typing indicator to humanize with.
  async postToChannel(
    request: SendRequest,
    channelId: string,
    body: ChannelPostBody
  ): Promise<SendResult> {
    const hash = this.hashOf(request, { op: 'channelPost', channelId, body })
    return (
      (await this.replayOf(request, hash)) ??
      this.submit(request, { ...body, to: channelId }, channelId, undefined, hash)
    )
  }

  // A forward is a send like any other: same queue, policy, pacing and idempotency. It has no
  // humanize (there is no text to type) and its outcome carries no message.
  async forward(request: SendRequest, messageId: string, to: string): Promise<SendResult> {
    const hash = this.hashOf(request, { op: 'forward', messageId, to })
    const replay = await this.replayOf(request, hash)
    if (replay) return replay
    const chatId = await this.recipients.resolve(request.sessionId, to)
    if (isChannelId(chatId)) {
      throw new ValidationError('VALIDATION_ERROR', 'A message cannot be forwarded to a channel', {
        field: 'chatId'
      })
    }
    await this.checkPolicy(request.sessionId, chatId, undefined)
    return this.enqueue(
      request,
      { sessionId: request.sessionId, chatId, content: { type: 'forward', messageId } },
      hash
    )
  }

  // What makes two requests the same is the request as the caller wrote it (without `wait`, which is
  // about the answer): the resolved recipient, the downloaded media and the session defaults can change
  // between two identical requests
  private hashOf(request: SendRequest, raw: unknown): string | undefined {
    return request.idempotencyKey === undefined ? undefined : sha256Hex(canonicalJson(raw))
  }

  private async replayOf(
    request: SendRequest,
    hash: string | undefined
  ): Promise<SendResult | undefined> {
    if (request.idempotencyKey === undefined || hash === undefined) return undefined
    return this.sender.peek(request.sessionId, request.idempotencyKey, hash)
  }

  private async chatOf(sessionId: string, messageId: string): Promise<string> {
    const message = await this.sessions.requireReady(sessionId).getMessageById(messageId)
    if (message === null)
      throw new NotFoundError('NOT_FOUND', `Message ${messageId} does not exist`)
    return message.chatId
  }

  // The cheap checks come first: the policy can refuse a recipient before any media is downloaded
  private async submit(
    request: SendRequest,
    body: AnyBody,
    to: string,
    quotedMessageId: string | undefined,
    hash: string | undefined
  ): Promise<SendResult> {
    const { sessionId } = request
    const chatId = await this.recipients.resolve(sessionId, to)
    await this.checkPolicy(sessionId, chatId, policyTextOf(body))
    const toChannel = isChannelId(chatId)
    if (toChannel && body.type !== 'text' && body.type !== 'media') {
      throw new ValidationError(
        'VALIDATION_ERROR',
        'A channel takes text or one media file, nothing else',
        { field: 'type' }
      )
    }
    const { content, options } = await this.contentOf(sessionId, body)
    if (toChannel) this.assertChannelOptions(options, quotedMessageId)
    // A channel has no chat state, so there is nothing to type or mark as seen first
    const humanize = toChannel
      ? undefined
      : await this.humanizeDefaults.resolve(sessionId, body.humanize, content.type)
    return this.enqueue(
      request,
      {
        sessionId,
        chatId,
        content,
        options: { ...options, ...(quotedMessageId !== undefined && { quotedMessageId }) },
        ...(humanize !== undefined && { humanize })
      },
      hash
    )
  }

  private enqueue(
    request: SendRequest,
    base: NewSendJob,
    requestHash: string | undefined
  ): Promise<SendResult> {
    const job: NewSendJob = {
      ...base,
      ...(request.idempotencyKey !== undefined && { idempotencyKey: request.idempotencyKey })
    }
    return this.sender.send(job, {
      ...(request.wait && { waitMs: this.config.SEND_SYNC_TIMEOUT_MS }),
      ...(requestHash !== undefined && { requestHash })
    })
  }

  // The channel call carries a caption and mentions only: anything else would be dropped while the
  // job reported `sent`, a quote above all (a reply would go out as a plain post)
  private assertChannelOptions(options: SendOptions, quotedMessageId: string | undefined): void {
    const unsupported = [
      ...(quotedMessageId === undefined ? [] : ['quotedMessageId']),
      ...Object.keys(options).filter(key => key !== 'caption' && key !== 'mentions')
    ]
    if (unsupported.length > 0) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        'A channel post takes text or media with a caption and mentions only',
        { fields: unsupported }
      )
    }
  }

  // The cheap answer of the policy at enqueue; the worker asks again before it dispatches
  private async checkPolicy(
    sessionId: string,
    chatId: string,
    body: string | undefined
  ): Promise<void> {
    const decision = await this.policy.check({ sessionId, chatId, body, waitedMs: 0 })
    if (decision.decision === 'reject') {
      throw new AppError(decision.code, undefined, { rule: decision.rule })
    }
  }

  private async contentOf(
    sessionId: string,
    body: AnyBody
  ): Promise<{ content: OutboundContent; options: SendOptions }> {
    const options = commonOptions(body)
    switch (body.type) {
      case 'text':
        return { content: { type: 'text', body: body.body }, options }
      case 'media': {
        const media = await this.media.resolve(sessionId, body.source)
        return {
          content: { type: 'media', media },
          options: {
            ...options,
            ...(body.caption !== undefined && { caption: body.caption }),
            ...(body.asDocument !== undefined && { sendMediaAsDocument: body.asDocument }),
            ...(body.asVoice !== undefined && { sendAudioAsVoice: body.asVoice }),
            ...(body.asGif !== undefined && { sendVideoAsGif: body.asGif }),
            ...(body.asSticker !== undefined && { sendMediaAsSticker: body.asSticker }),
            ...(body.asHd !== undefined && { sendMediaAsHd: body.asHd }),
            ...(body.viewOnce !== undefined && { isViewOnce: body.viewOnce }),
            ...(body.stickerName !== undefined && { stickerName: body.stickerName }),
            ...(body.stickerAuthor !== undefined && { stickerAuthor: body.stickerAuthor }),
            ...(body.stickerCategories !== undefined && {
              stickerCategories: body.stickerCategories
            })
          }
        }
      }
      case 'location':
        return {
          content: {
            type: 'location',
            latitude: body.latitude,
            longitude: body.longitude,
            ...(body.name !== undefined && { name: body.name }),
            ...(body.address !== undefined && { address: body.address }),
            ...(body.url !== undefined && { url: body.url })
          },
          options
        }
      case 'contact':
        return this.contactOf(body, options)
      case 'contacts':
        return { content: { type: 'contacts', contactIds: body.contactIds }, options }
      case 'poll':
        return {
          content: {
            type: 'poll',
            name: body.name,
            options: body.options,
            ...(body.allowMultipleAnswers !== undefined && {
              allowMultipleAnswers: body.allowMultipleAnswers
            })
          },
          options
        }
      case 'event':
        return {
          content: {
            type: 'event',
            name: body.name,
            startTime: new Date(body.startTime),
            ...(body.endTime !== undefined && { endTime: new Date(body.endTime) }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.location !== undefined && { location: body.location })
          },
          options
        }
      case 'groupInvite':
        // WhatsApp shows the invite link of a group as a card when it goes as text
        return {
          content: { type: 'text', body: `${GROUP_INVITE_BASE}${body.inviteCode}` },
          options: { linkPreview: true, ...options }
        }
    }
  }

  // One contact by id goes as a contact card; a vCard goes as text that WhatsApp parses into one.
  // The body schema guarantees exactly one of them is there.
  private contactOf(
    body: Extract<AnyBody, { type: 'contact' }>,
    options: SendOptions
  ): { content: OutboundContent; options: SendOptions } {
    if (body.contactId !== undefined) {
      return { content: { type: 'contacts', contactIds: [body.contactId] }, options }
    }
    return {
      content: { type: 'text', body: body.vcard ?? '' },
      options: { ...options, parseVCards: true }
    }
  }
}
