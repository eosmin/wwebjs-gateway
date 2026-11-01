import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put
} from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { GroupsService } from '../../services/groups.service.js'
import type { GroupChatDto, MembershipRequestDto } from '../../types/dto.js'
import {
  CreateGroupBodyDto,
  CreateGroupResultDto,
  GroupListDto,
  GroupParticipantsBodyDto,
  GroupResponseDto,
  GroupSettingsBodyDto,
  InviteCodeDto,
  InviteInfoDto,
  JoinGroupBodyDto,
  JoinedGroupDto,
  MembershipRequestListDto,
  MembershipRequestsActionBodyDto,
  MembershipRequestsResultDto,
  ParticipantsResultDto,
  SessionGroupParamsDto,
  SessionInviteParamsDto,
  SetGroupPictureBodyDto,
  UpdateGroupBodyDto,
  inviteUrl
} from '../../types/groups.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import type { CreateGroupResult } from '../../whatsapp/whatsapp-client.port.js'
import { WaOperation } from '../wa-operation.decorator.js'

const ON_SESSION: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'SESSION_NOT_READY',
  'WHATSAPP_ERROR'
]
const ON_GROUP: ErrorCode[] = [...ON_SESSION, 'CHAT_NOT_FOUND']
const ON_PICTURE: ErrorCode[] = [...ON_GROUP, 'PAYLOAD_TOO_LARGE', 'MEDIA_FETCH_FAILED']

const GROUP_ID = '120363000000000001@g.us'
const USER_ID = '5215500000001@c.us'
const GROUP = {
  id: GROUP_ID,
  archived: false,
  isGroup: true,
  isReadOnly: false,
  isMuted: false,
  muteExpiration: 0,
  name: 'Clientes',
  timestamp: 1767225600,
  unreadCount: 0,
  pinned: false,
  isLocked: false,
  owner: USER_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  description: null,
  participants: [{ id: USER_ID, isAdmin: true, isSuperAdmin: true }]
}

// The groups of the account: reading them, creating and changing one, its participants, its invite
// and the requests to enter it. The messages of a group are the chats and messages routes; the V4
// invite a message carries is `messages.acceptGroupInvite`.
@Controller('v1/sessions')
export class GroupsController {
  constructor(@Inject(GroupsService) private readonly groups: GroupsService) {}

  // The static routes (`join`, `invite-info`) are declared before the ones of `:groupId`

  @Post(':sessionId/groups')
  @ZodResponse({ status: HttpStatus.CREATED, type: CreateGroupResultDto })
  @WaOperation({
    id: 'groups.create',
    scope: 'manage',
    summary: 'Create a group',
    description:
      'Creates the group with the listed participants (user ids; the account is the creator). WhatsApp answers per participant: one it cannot add directly gets an invite when `autoSendInviteV4` is true (the wwebjs default), and its entry says so. Fails with `WHATSAPP_ERROR` when WhatsApp does not create the group.',
    errors: ON_SESSION,
    examples: {
      request: { subject: 'Clientes', participants: [USER_ID], messageTimer: 0 },
      response: {
        subject: 'Clientes',
        groupId: GROUP_ID,
        participants: {
          [USER_ID]: {
            statusCode: 200,
            message: 'The participant was added',
            isGroupCreator: false,
            isInviteV4Sent: false
          }
        }
      }
    },
    wwebjs: [
      'Client.createGroup',
      'CreateGroupOptions.autoSendInviteV4',
      'CreateGroupOptions.comment',
      'CreateGroupOptions.isAnnounce',
      'CreateGroupOptions.isRestrict',
      'CreateGroupOptions.memberAddMode',
      'CreateGroupOptions.membershipApprovalMode',
      'CreateGroupOptions.messageTimer',
      'CreateGroupOptions.parentGroupId',
      'CreateGroupResult.gid',
      'CreateGroupResult.participants',
      'CreateGroupResult.title'
    ]
  })
  async create(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() body: CreateGroupBodyDto
  ): Promise<CreateGroupResultDto> {
    const { title, gid, participants }: CreateGroupResult = await this.groups.create(
      sessionId,
      body
    )
    return { subject: title, groupId: gid, participants }
  }

  @Get(':sessionId/groups')
  @ZodResponse({ type: GroupListDto })
  @WaOperation({
    id: 'groups.list',
    scope: 'read',
    summary: 'List the groups',
    description:
      'The groups WhatsApp Web has loaded, each with its participants. The same chats as `chats.list`, without the private chats and the channels.',
    errors: ON_SESSION,
    examples: { request: null, response: { items: [GROUP] } },
    gateway: true,
    wwebjs: []
  })
  async list(@Param() { sessionId }: SessionIdParamsDto): Promise<GroupListDto> {
    return { items: await this.groups.list(sessionId) }
  }

  @Post(':sessionId/groups/join')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ status: HttpStatus.OK, type: JoinedGroupDto })
  @WaOperation({
    id: 'groups.join',
    scope: 'manage',
    summary: 'Join a group by its invite code',
    description:
      'Joins the group of an invite link (`https://chat.whatsapp.com/<inviteCode>`) and answers its id. Fails with `WHATSAPP_ERROR` when the code is wrong, expired or revoked, or when the group asks an admin to approve.',
    errors: ON_SESSION,
    examples: {
      request: { inviteCode: 'AbCdEfGhIjKlMnOpQrStUv' },
      response: { groupId: GROUP_ID }
    },
    wwebjs: ['Client.acceptInvite']
  })
  async join(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { inviteCode }: JoinGroupBodyDto
  ): Promise<JoinedGroupDto> {
    return { groupId: await this.groups.join(sessionId, inviteCode) }
  }

  @Get(':sessionId/groups/invite-info/:inviteCode')
  @ZodResponse({ type: InviteInfoDto })
  @WaOperation({
    id: 'groups.inviteInfo',
    scope: 'read',
    summary: 'Read what an invite code points to',
    description:
      'What WhatsApp tells about the group of an invite code, without joining it (subject, size, creator). The fields are WhatsApp’s own, passed through sanitized.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: { info: { subject: 'Clientes', size: 12 } }
    },
    wwebjs: ['Client.getInviteInfo']
  })
  async inviteInfo(
    @Param() { sessionId, inviteCode }: SessionInviteParamsDto
  ): Promise<InviteInfoDto> {
    return { info: await this.groups.inviteInfo(sessionId, inviteCode) }
  }

  @Get(':sessionId/groups/:groupId')
  @ZodResponse({ type: GroupResponseDto })
  @WaOperation({
    id: 'groups.get',
    scope: 'read',
    summary: 'Read a group',
    description:
      'One group with its owner, creation date, description and participants. Answers 404 `CHAT_NOT_FOUND` when the session has no such chat or it is not a group.',
    errors: ON_GROUP,
    examples: { request: null, response: GROUP },
    wwebjs: [
      'GroupChat.createdAt',
      'GroupChat.description',
      'GroupChat.owner',
      'GroupChat.participants'
    ]
  })
  get(@Param() { sessionId, groupId }: SessionGroupParamsDto): Promise<GroupChatDto> {
    return this.groups.get(sessionId, groupId)
  }

  @Patch(':sessionId/groups/:groupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'groups.update',
    scope: 'manage',
    summary: 'Change the subject or the description',
    description:
      'Sets what is sent: the subject first, then the description. WhatsApp has no call that sets both, so a failure of the second leaves the first applied. Fails with `WHATSAPP_ERROR` when WhatsApp refuses (the account is not an admin and the group restricts the info).',
    errors: ON_GROUP,
    examples: { request: { subject: 'Clientes VIP', description: 'Avisos' }, response: null },
    wwebjs: ['GroupChat.setDescription', 'GroupChat.setSubject']
  })
  update(
    @Param() { sessionId, groupId }: SessionGroupParamsDto,
    @Body() body: UpdateGroupBodyDto
  ): Promise<void> {
    return this.groups.update(sessionId, groupId, body)
  }

  @Patch(':sessionId/groups/:groupId/settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'groups.settings',
    scope: 'manage',
    summary: 'Change who can send, edit and add',
    description:
      'Sets what is sent, one setting at a time in the order `messagesAdminsOnly`, `infoAdminsOnly`, `addMembersAdminsOnly`; a failure leaves the ones before it applied. Needs an admin account.',
    errors: ON_GROUP,
    examples: { request: { messagesAdminsOnly: true }, response: null },
    wwebjs: [
      'GroupChat.setAddMembersAdminsOnly',
      'GroupChat.setInfoAdminsOnly',
      'GroupChat.setMessagesAdminsOnly'
    ]
  })
  settings(
    @Param() { sessionId, groupId }: SessionGroupParamsDto,
    @Body() body: GroupSettingsBodyDto
  ): Promise<void> {
    return this.groups.settings(sessionId, groupId, body)
  }

  @Post(':sessionId/groups/:groupId/participants')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ status: HttpStatus.OK, type: ParticipantsResultDto })
  @WaOperation({
    id: 'groups.participants',
    scope: 'manage',
    summary: 'Add, remove, promote or demote participants',
    description:
      'One action on a list of user ids. `add` answers per participant (a participant WhatsApp cannot add gets an invite when `options.autoSendInviteV4` is true); the other three answer the `status` WhatsApp gave. Needs an admin account. At most 256 ids per call.',
    errors: ON_GROUP,
    examples: {
      request: { action: 'add', participants: [USER_ID], options: { autoSendInviteV4: false } },
      response: {
        participants: {
          [USER_ID]: { code: 200, message: 'The participant was added', isInviteV4Sent: false }
        }
      }
    },
    wwebjs: [
      'AddParticipantsOptions.autoSendInviteV4',
      'AddParticipantsOptions.comment',
      'AddParticipantsOptions.sleep',
      'GroupChat.addParticipants',
      'GroupChat.demoteParticipants',
      'GroupChat.promoteParticipants',
      'GroupChat.removeParticipants'
    ]
  })
  participants(
    @Param() { sessionId, groupId }: SessionGroupParamsDto,
    @Body() body: GroupParticipantsBodyDto
  ): Promise<ParticipantsResultDto> {
    return this.groups.participants(sessionId, groupId, body)
  }

  @Get(':sessionId/groups/:groupId/invite')
  @ZodResponse({ type: InviteCodeDto })
  @WaOperation({
    id: 'groups.invite',
    scope: 'manage',
    summary: 'Read the invite link of a group',
    description:
      'The code and the link that let anyone join the group. It is `manage`, not `read`: the link is a credential of the group.',
    errors: ON_GROUP,
    examples: {
      request: null,
      response: {
        code: 'AbCdEfGhIjKlMnOpQrStUv',
        url: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv'
      }
    },
    wwebjs: ['GroupChat.getInviteCode']
  })
  async invite(@Param() { sessionId, groupId }: SessionGroupParamsDto): Promise<InviteCodeDto> {
    const code = await this.groups.inviteCode(sessionId, groupId)
    return { code, url: inviteUrl(code) }
  }

  @Post(':sessionId/groups/:groupId/invite/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'groups.revokeInvite',
    scope: 'manage',
    summary: 'Revoke the invite link of a group',
    description:
      'The old link stops working; read the new one with `groups.invite`. Needs an admin account.',
    errors: ON_GROUP,
    examples: { request: null, response: null },
    wwebjs: ['GroupChat.revokeInvite']
  })
  revokeInvite(@Param() { sessionId, groupId }: SessionGroupParamsDto): Promise<void> {
    return this.groups.revokeInvite(sessionId, groupId)
  }

  @Put(':sessionId/groups/:groupId/picture')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'groups.setPicture',
    scope: 'manage',
    summary: 'Change the picture of a group',
    description:
      'Sets the picture from inline `base64`, a public `url` or the image of a stored message. Anything that is not an image is a 400. A `url` goes through the SSRF guard and the size cap `MAX_MEDIA_BYTES`; the body of a request is limited to 1 MiB, so a larger image goes by `url`.',
    errors: ON_PICTURE,
    examples: {
      request: { source: { url: 'https://example.com/logo.png' } },
      response: null
    },
    wwebjs: ['GroupChat.setPicture']
  })
  setPicture(
    @Param() { sessionId, groupId }: SessionGroupParamsDto,
    @Body() { source }: SetGroupPictureBodyDto
  ): Promise<void> {
    return this.groups.setPicture(sessionId, groupId, source)
  }

  @Delete(':sessionId/groups/:groupId/picture')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'groups.deletePicture',
    scope: 'manage',
    summary: 'Delete the picture of a group',
    description: 'Removes the picture. Fails with `WHATSAPP_ERROR` when WhatsApp refuses.',
    errors: ON_GROUP,
    examples: { request: null, response: null },
    wwebjs: ['GroupChat.deletePicture']
  })
  deletePicture(@Param() { sessionId, groupId }: SessionGroupParamsDto): Promise<void> {
    return this.groups.deletePicture(sessionId, groupId)
  }

  @Post(':sessionId/groups/:groupId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'groups.leave',
    scope: 'manage',
    summary: 'Leave a group',
    description:
      'The account leaves the group. The chat stays in the list until `chats.delete` removes it.',
    errors: ON_GROUP,
    examples: { request: null, response: null },
    wwebjs: ['GroupChat.leave']
  })
  leave(@Param() { sessionId, groupId }: SessionGroupParamsDto): Promise<void> {
    return this.groups.leave(sessionId, groupId)
  }

  @Get(':sessionId/groups/:groupId/membership-requests')
  @ZodResponse({ type: MembershipRequestListDto })
  @WaOperation({
    id: 'groups.membershipRequests',
    scope: 'read',
    summary: 'List who asks to join a group',
    description:
      'The pending requests to enter a group that asks an admin to approve. Needs an admin account.',
    errors: ON_GROUP,
    examples: {
      request: null,
      response: {
        items: [
          {
            id: USER_ID,
            addedBy: USER_ID,
            requestMethod: 'InviteLink',
            t: 1767225600
          }
        ]
      }
    },
    wwebjs: [
      'Client.getGroupMembershipRequests',
      'GroupChat.getGroupMembershipRequests',
      'GroupMembershipRequest.addedBy',
      'GroupMembershipRequest.id',
      'GroupMembershipRequest.parentGroupId',
      'GroupMembershipRequest.requestMethod',
      'GroupMembershipRequest.t'
    ]
  })
  async membershipRequests(
    @Param() { sessionId, groupId }: SessionGroupParamsDto
  ): Promise<{ items: MembershipRequestDto[] }> {
    return { items: await this.groups.membershipRequests(sessionId, groupId) }
  }

  @Post(':sessionId/groups/:groupId/membership-requests/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ status: HttpStatus.OK, type: MembershipRequestsResultDto })
  @WaOperation({
    id: 'groups.approveRequests',
    scope: 'manage',
    summary: 'Approve requests to join a group',
    description:
      'Approves the listed requesters, or every pending request when `requesterIds` is left out. The answer has one entry per request; an entry with `error` is one WhatsApp refused. Needs an admin account.',
    errors: ON_GROUP,
    examples: {
      request: { requesterIds: [USER_ID] },
      response: { items: [{ requesterId: USER_ID, message: 'Approved' }] }
    },
    wwebjs: [
      'Client.approveGroupMembershipRequests',
      'GroupChat.approveGroupMembershipRequests',
      'MembershipRequestActionOptions.requesterIds',
      'MembershipRequestActionOptions.sleep',
      'MembershipRequestActionResult.error',
      'MembershipRequestActionResult.message',
      'MembershipRequestActionResult.requesterId'
    ]
  })
  async approveRequests(
    @Param() { sessionId, groupId }: SessionGroupParamsDto,
    @Body() body: MembershipRequestsActionBodyDto
  ): Promise<MembershipRequestsResultDto> {
    return { items: await this.groups.approveRequests(sessionId, groupId, body) }
  }

  @Post(':sessionId/groups/:groupId/membership-requests/reject')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ status: HttpStatus.OK, type: MembershipRequestsResultDto })
  @WaOperation({
    id: 'groups.rejectRequests',
    scope: 'manage',
    summary: 'Reject requests to join a group',
    description:
      'Rejects the listed requesters, or every pending request when `requesterIds` is left out. Same answer as `groups.approveRequests`.',
    errors: ON_GROUP,
    examples: {
      request: { requesterIds: [USER_ID] },
      response: { items: [{ requesterId: USER_ID, message: 'Rejected' }] }
    },
    wwebjs: [
      'Client.rejectGroupMembershipRequests',
      'GroupChat.rejectGroupMembershipRequests',
      'MembershipRequestActionOptions.requesterIds',
      'MembershipRequestActionOptions.sleep',
      'MembershipRequestActionResult.error',
      'MembershipRequestActionResult.message',
      'MembershipRequestActionResult.requesterId'
    ]
  })
  async rejectRequests(
    @Param() { sessionId, groupId }: SessionGroupParamsDto,
    @Body() body: MembershipRequestsActionBodyDto
  ): Promise<MembershipRequestsResultDto> {
    return { items: await this.groups.rejectRequests(sessionId, groupId, body) }
  }
}
