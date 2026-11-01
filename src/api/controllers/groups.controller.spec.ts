import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope and the wwebjs symbols of every groups operation
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'groups.create': {
    scope: 'manage',
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
  },
  'groups.list': { scope: 'read', wwebjs: [] },
  'groups.join': { scope: 'manage', wwebjs: ['Client.acceptInvite'] },
  'groups.inviteInfo': { scope: 'read', wwebjs: ['Client.getInviteInfo'] },
  'groups.get': {
    scope: 'read',
    wwebjs: [
      'GroupChat.createdAt',
      'GroupChat.description',
      'GroupChat.owner',
      'GroupChat.participants'
    ]
  },
  'groups.update': {
    scope: 'manage',
    wwebjs: ['GroupChat.setDescription', 'GroupChat.setSubject']
  },
  'groups.settings': {
    scope: 'manage',
    wwebjs: [
      'GroupChat.setAddMembersAdminsOnly',
      'GroupChat.setInfoAdminsOnly',
      'GroupChat.setMessagesAdminsOnly'
    ]
  },
  'groups.participants': {
    scope: 'manage',
    wwebjs: [
      'AddParticipantsOptions.autoSendInviteV4',
      'AddParticipantsOptions.comment',
      'AddParticipantsOptions.sleep',
      'GroupChat.addParticipants',
      'GroupChat.demoteParticipants',
      'GroupChat.promoteParticipants',
      'GroupChat.removeParticipants'
    ]
  },
  // The link is a credential of the group, so reading it needs `manage`
  'groups.invite': { scope: 'manage', wwebjs: ['GroupChat.getInviteCode'] },
  'groups.revokeInvite': { scope: 'manage', wwebjs: ['GroupChat.revokeInvite'] },
  'groups.setPicture': { scope: 'manage', wwebjs: ['GroupChat.setPicture'] },
  'groups.deletePicture': { scope: 'manage', wwebjs: ['GroupChat.deletePicture'] },
  'groups.leave': { scope: 'manage', wwebjs: ['GroupChat.leave'] },
  'groups.membershipRequests': {
    scope: 'read',
    wwebjs: [
      'Client.getGroupMembershipRequests',
      'GroupChat.getGroupMembershipRequests',
      'GroupMembershipRequest.addedBy',
      'GroupMembershipRequest.id',
      'GroupMembershipRequest.parentGroupId',
      'GroupMembershipRequest.requestMethod',
      'GroupMembershipRequest.t'
    ]
  },
  'groups.approveRequests': {
    scope: 'manage',
    wwebjs: [
      'Client.approveGroupMembershipRequests',
      'GroupChat.approveGroupMembershipRequests',
      'MembershipRequestActionOptions.requesterIds',
      'MembershipRequestActionOptions.sleep',
      'MembershipRequestActionResult.error',
      'MembershipRequestActionResult.message',
      'MembershipRequestActionResult.requesterId'
    ]
  },
  'groups.rejectRequests': {
    scope: 'manage',
    wwebjs: [
      'Client.rejectGroupMembershipRequests',
      'GroupChat.rejectGroupMembershipRequests',
      'MembershipRequestActionOptions.requesterIds',
      'MembershipRequestActionOptions.sleep',
      'MembershipRequestActionResult.error',
      'MembershipRequestActionResult.message',
      'MembershipRequestActionResult.requesterId'
    ]
  }
}

describe('GroupsController operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const groups = (await collectOperations(MessagesModule)).filter(operation =>
      operation.id.startsWith('groups.')
    )

    expect(
      Object.fromEntries(groups.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })
})
