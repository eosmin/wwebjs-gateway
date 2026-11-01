import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError, ValidationError, WhatsAppError } from '../common/errors.js'
import type { GroupChatDto, MembershipRequestDto } from '../types/dto.js'
import type {
  CreateGroupBody,
  GroupParticipantsBody,
  GroupSettingsBody
} from '../types/groups.dto.js'
import type { MediaSource } from '../types/messages.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type {
  AddParticipantsResult,
  AnyChatDto,
  CreateGroupResult,
  MembershipRequestActionOptions,
  MembershipRequestActionResult
} from '../whatsapp/whatsapp-client.port.js'

import { MediaResolverService } from './media-resolver.service.js'

export interface ParticipantsOutcome {
  status?: number
  participants?: Exclude<AddParticipantsResult, string>
}

// A key with no value is left out, so that wwebjs applies its own default
const compact = <T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }

const isGroup = (chat: AnyChatDto): chat is GroupChatDto =>
  chat.isGroup === true && 'participants' in chat

// What the groups routes do: reads, the changes to one group, its participants, its invite and the
// requests to enter it; each one a call to the session's client.
@Injectable()
export class GroupsService {
  constructor(
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(MediaResolverService) private readonly media: MediaResolverService
  ) {}

  // ---- Reads -----------------------------------------------------------------------------------

  async list(sessionId: string): Promise<GroupChatDto[]> {
    return (await this.sessions.requireReady(sessionId).getChats()).filter(isGroup)
  }

  async get(sessionId: string, groupId: string): Promise<GroupChatDto> {
    const chat = await this.sessions.requireReady(sessionId).getChatById(groupId)
    if (!isGroup(chat)) throw new NotFoundError('CHAT_NOT_FOUND', 'The chat is not a group')
    return chat
  }

  inviteCode(sessionId: string, groupId: string): Promise<string> {
    return this.sessions.requireReady(sessionId).getGroupInviteCode(groupId)
  }

  membershipRequests(sessionId: string, groupId: string): Promise<MembershipRequestDto[]> {
    return this.sessions.requireReady(sessionId).getGroupMembershipRequests(groupId)
  }

  inviteInfo(sessionId: string, inviteCode: string): Promise<Record<string, unknown>> {
    return this.sessions.requireReady(sessionId).getInviteInfo(inviteCode)
  }

  // ---- Create and join -------------------------------------------------------------------------

  // wwebjs answers a failure with a text instead of throwing
  async create(sessionId: string, body: CreateGroupBody): Promise<CreateGroupResult> {
    const { subject, participants, ...options } = body
    const result = await this.sessions
      .requireReady(sessionId)
      .createGroup(subject, participants, compact(options))
    if (typeof result === 'string') {
      throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp did not create the group', {
        reason: result
      })
    }
    return result
  }

  async join(sessionId: string, inviteCode: string): Promise<string> {
    return this.sessions.requireReady(sessionId).acceptInvite(inviteCode)
  }

  // ---- Changes ---------------------------------------------------------------------------------

  // The subject first, then the description: WhatsApp has no call that sets both, so a failure of
  // the second leaves the first applied; the error says which ones were applied
  async update(
    sessionId: string,
    groupId: string,
    changes: { subject?: string; description?: string }
  ): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const applied: string[] = []
    if (changes.subject !== undefined) {
      this.assertDone(
        await client.setGroupSubject(groupId, changes.subject),
        'change the subject',
        'subject',
        applied
      )
      applied.push('subject')
    }
    if (changes.description !== undefined) {
      this.assertDone(
        await client.setGroupDescription(groupId, changes.description),
        'change the description',
        'description',
        applied
      )
    }
  }

  // One call per setting, in a fixed order; a failure leaves the ones before it applied, and the
  // error says which
  async settings(sessionId: string, groupId: string, settings: GroupSettingsBody): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const applied: string[] = []
    const steps = [
      [
        'messagesAdminsOnly',
        'change who sends messages',
        (value: boolean) => client.setMessagesAdminsOnly(groupId, value)
      ],
      [
        'infoAdminsOnly',
        'change who edits the group info',
        (value: boolean) => client.setInfoAdminsOnly(groupId, value)
      ],
      [
        'addMembersAdminsOnly',
        'change who adds people',
        (value: boolean) => client.setAddMembersAdminsOnly(groupId, value)
      ]
    ] as const
    for (const [key, what, call] of steps) {
      const value = settings[key]
      if (value === undefined) continue
      this.assertDone(await call(value), what, key, applied)
      applied.push(key)
    }
  }

  async participants(
    sessionId: string,
    groupId: string,
    { action, participants, options }: GroupParticipantsBody
  ): Promise<ParticipantsOutcome> {
    const client = this.sessions.requireReady(sessionId)
    switch (action) {
      case 'add': {
        const result = await client.addParticipants(
          groupId,
          participants,
          options === undefined ? undefined : compact(options)
        )
        if (typeof result === 'string') {
          throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp did not add the participants', {
            reason: result
          })
        }
        return { participants: result }
      }
      case 'remove':
        return this.assertStatus(await client.removeParticipants(groupId, participants))
      case 'promote':
        return this.assertStatus(await client.promoteParticipants(groupId, participants))
      case 'demote':
        return this.assertStatus(await client.demoteParticipants(groupId, participants))
    }
  }

  async revokeInvite(sessionId: string, groupId: string): Promise<void> {
    await this.sessions.requireReady(sessionId).revokeGroupInvite(groupId)
  }

  async leave(sessionId: string, groupId: string): Promise<void> {
    await this.sessions.requireReady(sessionId).leaveGroup(groupId)
  }

  async setPicture(sessionId: string, groupId: string, source: MediaSource): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const picture = await this.media.resolve(sessionId, source)
    if (!picture.mimetype.toLowerCase().startsWith('image/')) {
      throw new ValidationError('VALIDATION_ERROR', 'The group picture must be an image', {
        field: 'source',
        mimetype: picture.mimetype
      })
    }
    this.assertDone(await client.setGroupPicture(groupId, picture), 'change the group picture')
  }

  async deletePicture(sessionId: string, groupId: string): Promise<void> {
    this.assertDone(
      await this.sessions.requireReady(sessionId).deleteGroupPicture(groupId),
      'delete the group picture'
    )
  }

  // ---- Requests to enter -----------------------------------------------------------------------

  approveRequests(
    sessionId: string,
    groupId: string,
    options: MembershipRequestActionOptions
  ): Promise<MembershipRequestActionResult[]> {
    return this.sessions
      .requireReady(sessionId)
      .approveGroupMembershipRequests(groupId, compact(options))
  }

  rejectRequests(
    sessionId: string,
    groupId: string,
    options: MembershipRequestActionOptions
  ): Promise<MembershipRequestActionResult[]> {
    return this.sessions
      .requireReady(sessionId)
      .rejectGroupMembershipRequests(groupId, compact(options))
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

  // wwebjs answers the status WhatsApp gave; anything but a 2xx is a refusal
  private assertStatus(result: { status: number }): { status: number } {
    if (result.status < 200 || result.status >= 300) {
      throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp refused the change of participants', {
        status: result.status
      })
    }
    return result
  }
}
