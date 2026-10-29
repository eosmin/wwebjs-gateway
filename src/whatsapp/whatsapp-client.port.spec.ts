import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { WA_EVENT_NAMES } from '../types/events.js'

import type {
  ClientEvent,
  ClientEventName,
  GatewayOnlyEvent,
  WhatsAppClientPort
} from './whatsapp-client.port.js'
import { WHATSAPP_CLIENT_FACTORY } from './whatsapp-client.port.js'

type PortMethod = keyof WhatsAppClientPort

// Members of whatsapp-web.js 1.34.7 (TDD §6.12) that keep their name in the port
const CLIENT_MEMBERS = [
  'acceptInvite',
  'acceptChannelAdminInvite',
  'revokeChannelAdminInvite',
  'demoteChannelAdmin',
  'acceptGroupV4Invite',
  'getInviteInfo',
  'archiveChat',
  'pinChat',
  'unpinChat',
  'createGroup',
  'createChannel',
  'deleteChannel',
  'subscribeToChannel',
  'unsubscribeFromChannel',
  'searchChannels',
  'destroy',
  'logout',
  'getBlockedContacts',
  'getChatById',
  'getChannelByInviteCode',
  'getChats',
  'getChannels',
  'getContactById',
  'getMessageById',
  'getPinnedMessages',
  'getContacts',
  'getCountryCode',
  'getFormattedNumber',
  'getLabels',
  'getBroadcasts',
  'getBroadcastById',
  'revokeStatusMessage',
  'addOrRemoveLabels',
  'getLabelById',
  'getChatLabels',
  'getChatsByLabelId',
  'getProfilePicUrl',
  'getCommonGroups',
  'getState',
  'getWWebVersion',
  'initialize',
  'isRegisteredUser',
  'getNumberId',
  'muteChat',
  'requestPairingCode',
  'cancelPairingCode',
  'resetState',
  'sendMessage',
  'sendReaction',
  'sendChannelAdminInvite',
  'searchMessages',
  'sendPresenceAvailable',
  'sendPresenceUnavailable',
  'sendSeen',
  'markChatUnread',
  'setStatus',
  'setDisplayName',
  'setAutoDownloadAudio',
  'setAutoDownloadDocuments',
  'setAutoDownloadPhotos',
  'setAutoDownloadVideos',
  'setBackgroundSync',
  'getContactDeviceCount',
  'syncHistory',
  'saveOrEditAddressbookContact',
  'addOrEditCustomerNote',
  'getCustomerNote',
  'deleteAddressbookContact',
  'getContactLidAndPhone',
  'unarchiveChat',
  'unmuteChat',
  'setProfilePicture',
  'deleteProfilePicture',
  'createCallLink',
  'sendResponseToScheduledEvent',
  'getGroupMembershipRequests',
  'approveGroupMembershipRequests',
  'rejectGroupMembershipRequests',
  'transferChannelOwnership',
  'getPollVotes'
] as const satisfies readonly PortMethod[]

// The rest of the inventory: `Class.member` → the port method that carries it
const RENAMED = {
  'Client.info': 'getClientInfo',
  'Client.on': 'onEvent',

  'Chat.archive': 'archiveChat',
  'Chat.pin': 'pinChat',
  'Chat.unpin': 'unpinChat',
  'Chat.clearMessages': 'clearChatMessages',
  'Chat.clearState': 'sendChatState',
  'Chat.delete': 'deleteChat',
  'Chat.fetchMessages': 'fetchMessages',
  'Chat.mute': 'muteChat',
  'Chat.sendMessage': 'sendMessage',
  'Chat.sendSeen': 'sendSeen',
  'Chat.sendStateRecording': 'sendChatState',
  'Chat.sendStateTyping': 'sendChatState',
  'Chat.unarchive': 'unarchiveChat',
  'Chat.unmute': 'unmuteChat',
  'Chat.getContact': 'getContactById',
  'Chat.markUnread': 'markChatUnread',
  'Chat.getLabels': 'getChatLabels',
  'Chat.changeLabels': 'addOrRemoveLabels',
  'Chat.getPinnedMessages': 'getPinnedMessages',
  'Chat.syncHistory': 'syncHistory',
  'Chat.addOrEditCustomerNote': 'addOrEditCustomerNote',
  'Chat.getCustomerNote': 'getCustomerNote',

  'GroupChat.addParticipants': 'addParticipants',
  'GroupChat.removeParticipants': 'removeParticipants',
  'GroupChat.promoteParticipants': 'promoteParticipants',
  'GroupChat.demoteParticipants': 'demoteParticipants',
  'GroupChat.setSubject': 'setGroupSubject',
  'GroupChat.setDescription': 'setGroupDescription',
  'GroupChat.setAddMembersAdminsOnly': 'setAddMembersAdminsOnly',
  'GroupChat.setMessagesAdminsOnly': 'setMessagesAdminsOnly',
  'GroupChat.setInfoAdminsOnly': 'setInfoAdminsOnly',
  'GroupChat.getGroupMembershipRequests': 'getGroupMembershipRequests',
  'GroupChat.approveGroupMembershipRequests': 'approveGroupMembershipRequests',
  'GroupChat.rejectGroupMembershipRequests': 'rejectGroupMembershipRequests',
  'GroupChat.getInviteCode': 'getGroupInviteCode',
  'GroupChat.revokeInvite': 'revokeGroupInvite',
  'GroupChat.leave': 'leaveGroup',
  'GroupChat.setPicture': 'setGroupPicture',
  'GroupChat.deletePicture': 'deleteGroupPicture',

  'Channel.getSubscribers': 'getChannelSubscribers',
  'Channel.setSubject': 'setChannelSubject',
  'Channel.setDescription': 'setChannelDescription',
  'Channel.setProfilePicture': 'setChannelProfilePicture',
  'Channel.setReactionSetting': 'setChannelReactionSetting',
  'Channel.mute': 'muteChannel',
  'Channel.unmute': 'unmuteChannel',
  'Channel.sendMessage': 'sendChannelMessage',
  'Channel.sendSeen': 'sendSeen',
  'Channel.sendChannelAdminInvite': 'sendChannelAdminInvite',
  'Channel.acceptChannelAdminInvite': 'acceptChannelAdminInvite',
  'Channel.revokeChannelAdminInvite': 'revokeChannelAdminInvite',
  'Channel.demoteChannelAdmin': 'demoteChannelAdmin',
  'Channel.fetchMessages': 'fetchChannelMessages',
  'Channel.transferChannelOwnership': 'transferChannelOwnership',
  'Channel.deleteChannel': 'deleteChannel',

  'Message.reload': 'reloadMessage',
  'Message.acceptGroupV4Invite': 'acceptGroupV4Invite',
  'Message.delete': 'deleteMessage',
  'Message.downloadMedia': 'downloadMedia',
  'Message.getChat': 'getMessageChat',
  'Message.getContact': 'getMessageContact',
  'Message.getMentions': 'getMessageMentions',
  'Message.getGroupMentions': 'getMessageGroupMentions',
  'Message.getQuotedMessage': 'getQuotedMessage',
  'Message.reply': 'replyToMessage',
  'Message.react': 'sendReaction',
  'Message.forward': 'forwardMessage',
  'Message.star': 'starMessage',
  'Message.unstar': 'unstarMessage',
  'Message.pin': 'pinMessage',
  'Message.unpin': 'unpinMessage',
  'Message.getInfo': 'getMessageInfo',
  'Message.getOrder': 'getMessageOrder',
  'Message.getPayment': 'getMessagePayment',
  'Message.getPollVotes': 'getPollVotes',
  'Message.getReactions': 'getMessageReactions',
  'Message.edit': 'editMessage',
  'Message.editScheduledEvent': 'editScheduledEvent',
  'Message.vote': 'vote',

  'Contact.getProfilePicUrl': 'getProfilePicUrl',
  'Contact.getChat': 'getContactChat',
  'Contact.getCountryCode': 'getCountryCode',
  'Contact.getFormattedNumber': 'getFormattedNumber',
  'Contact.block': 'blockContact',
  'Contact.unblock': 'unblockContact',
  'Contact.getAbout': 'getContactAbout',
  'Contact.getCommonGroups': 'getCommonGroups',
  'Contact.getBroadcast': 'getContactBroadcast',

  'Label.getChats': 'getChatsByLabelId',
  'Broadcast.getChat': 'getChatById',
  'Broadcast.getContact': 'getContactById',
  'Call.reject': 'rejectCall',
  'GroupNotification.getChat': 'getChatById',
  'GroupNotification.getContact': 'getContactById',
  'GroupNotification.getRecipients': 'getContactById',
  'GroupNotification.reply': 'sendMessage'
} as const satisfies Record<string, PortMethod>

// What the port offers that no wwebjs member of the inventory names (ClientInfo has fields only)
type GatewayOnlyMethod = Extract<PortMethod, 'getBatteryStatus' | 'getBrowserMemoryBytes'>

// Fails to compile when the port has a method that nothing in the inventory maps to
type Uncovered = Exclude<
  PortMethod,
  (typeof CLIENT_MEMBERS)[number] | (typeof RENAMED)[keyof typeof RENAMED] | GatewayOnlyMethod
>
const everyMethodIsCovered: [Uncovered] extends [never] ? true : false = true

// The members of each class as TDD §6.12 lists them, read from the document itself
function inventoryOfTdd(): Map<string, string[]> {
  const tdd = readFileSync(join(process.cwd(), 'docs/TDD.md'), 'utf8')
  const section = tdd.slice(tdd.indexOf('### 6.12'), tdd.indexOf('### 6.13'))
  const inventory = new Map<string, string[]>()
  for (const [, title, members] of section.matchAll(
    /\*\*([\w /]+)\*\*(?: \(\d+ members\))?: `([^`]+)`/g
  )) {
    const className = (title ?? '').split(' / ')[0] ?? ''
    inventory.set(
      className,
      (members ?? '').split(',').map(name => name.trim())
    )
  }
  return inventory
}

const GROUPS = [
  'Client',
  'Chat',
  'GroupChat',
  'Channel',
  'Message',
  'Contact',
  'Label',
  'Broadcast',
  'Call',
  'GroupNotification'
]

describe('WhatsAppClientPort', () => {
  it('carries exactly the members that TDD §6.12 lists, class by class', () => {
    const inventory = inventoryOfTdd()
    const mapped = new Map<string, Set<string>>()
    for (const key of Object.keys(RENAMED)) {
      const [className = '', member = ''] = key.split('.')
      mapped.set(className, (mapped.get(className) ?? new Set()).add(member))
    }
    // The same-name members of Client are only in CLIENT_MEMBERS
    mapped.set('Client', new Set([...(mapped.get('Client') ?? []), ...CLIENT_MEMBERS]))

    for (const className of GROUPS) {
      expect([...(mapped.get(className) ?? [])].sort()).toEqual(
        [...(inventory.get(className) ?? [])].sort()
      )
    }
    // 82 listed names; the 84 of the TDD count `pupPage` and `pupBrowser`, unsupported on purpose
    expect(inventory.get('Client')).toHaveLength(82)
  })

  it('maps every method of the port to a member of the inventory', () => {
    // Checked when it compiles: `Uncovered` is never
    expect(everyMethodIsCovered).toBe(true)
  })

  it('emits every event of wwebjs, and none that the gateway makes up', () => {
    const gatewayOnly: GatewayOnlyEvent[] = [
      'session_status',
      'message_batch',
      'message_sent',
      'message_failed',
      'chat_suppressed',
      'chat_unreachable',
      'ping'
    ]
    const emitted = WA_EVENT_NAMES.filter(name => !gatewayOnly.includes(name as GatewayOnlyEvent))

    // The 31 events of wwebjs plus `session_error`, which the adapter raises itself
    expect(emitted).toHaveLength(32)
    expect(emitted).toContain('session_error')
    expect(emitted).not.toContain('message_batch')
  })

  it('types an event with the payload of its name', () => {
    const name: ClientEventName = 'qr'
    const event: ClientEvent = { event: name, data: { qr: 'text' } }
    // @ts-expect-error: message_batch is made by the pipeline, a client never emits it
    const made: ClientEvent = { event: 'message_batch', data: {} }
    // @ts-expect-error: the payload of qr is { qr: string }
    const wrong: ClientEvent = { event: 'qr', data: { code: 'x' } }

    expect([event, made, wrong]).toHaveLength(3)
  })

  it('exposes the injection token of the factory', () => {
    expect(WHATSAPP_CLIENT_FACTORY.description).toBe('WHATSAPP_CLIENT_FACTORY')
  })
})
