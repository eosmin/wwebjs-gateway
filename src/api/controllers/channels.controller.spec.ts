import { SEND_ROUTES } from '../../infra/logger/fastify-adapter.js'
import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope and the wwebjs symbols of every channels operation
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'channels.list': {
    scope: 'read',
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
  },
  'channels.byInvite': {
    scope: 'read',
    wwebjs: ['Client.getChannelByInviteCode']
  },
  'channels.search': {
    scope: 'read',
    wwebjs: [
      'Client.searchChannels',
      'SearchChannelsOptions.countryCodes',
      'SearchChannelsOptions.limit',
      'SearchChannelsOptions.searchText',
      'SearchChannelsOptions.skipSubscribedNewsletters',
      'SearchChannelsOptions.view'
    ]
  },
  'channels.create': {
    scope: 'manage',
    wwebjs: [
      'Client.createChannel',
      'CreateChannelOptions.description',
      'CreateChannelOptions.picture',
      'CreateChannelResult.createdAtTs',
      'CreateChannelResult.inviteLink',
      'CreateChannelResult.nid',
      'CreateChannelResult.title'
    ]
  },
  'channels.get': { scope: 'read', wwebjs: [] },
  'channels.delete': {
    scope: 'manage',
    wwebjs: ['Channel.deleteChannel', 'Client.deleteChannel']
  },
  'channels.update': {
    scope: 'manage',
    wwebjs: ['Channel.setDescription', 'Channel.setSubject']
  },
  'channels.setPicture': {
    scope: 'manage',
    wwebjs: ['Channel.setProfilePicture']
  },
  'channels.reactionSetting': {
    scope: 'manage',
    wwebjs: ['Channel.setReactionSetting']
  },
  'channels.subscribe': {
    scope: 'manage',
    wwebjs: ['Client.subscribeToChannel']
  },
  'channels.unsubscribe': {
    scope: 'manage',
    wwebjs: ['Client.unsubscribeFromChannel', 'UnsubscribeOptions.deleteLocalModels']
  },
  'channels.mute': {
    scope: 'manage',
    wwebjs: ['Channel.mute']
  },
  'channels.unmute': {
    scope: 'manage',
    wwebjs: ['Channel.unmute']
  },
  'channels.subscribers': {
    scope: 'read',
    wwebjs: ['Channel.getSubscribers']
  },
  'channels.messages': {
    scope: 'read',
    wwebjs: ['Channel.fetchMessages']
  },
  'channels.post': {
    scope: 'send',
    wwebjs: [
      'Channel.sendMessage',
      'MessageSendChannelOptions.caption',
      'MessageSendChannelOptions.media',
      'MessageSendChannelOptions.mentions'
    ]
  },
  'channels.inviteAdmin': {
    scope: 'manage',
    wwebjs: ['Channel.sendChannelAdminInvite', 'Client.sendChannelAdminInvite']
  },
  'channels.acceptAdminInvite': {
    scope: 'manage',
    wwebjs: ['Channel.acceptChannelAdminInvite', 'Client.acceptChannelAdminInvite']
  },
  'channels.revokeAdminInvite': {
    scope: 'manage',
    wwebjs: ['Channel.revokeChannelAdminInvite', 'Client.revokeChannelAdminInvite']
  },
  'channels.demoteAdmin': {
    scope: 'manage',
    wwebjs: ['Channel.demoteChannelAdmin', 'Client.demoteChannelAdmin']
  },
  'channels.transferOwnership': {
    scope: 'manage',
    wwebjs: [
      'Channel.transferChannelOwnership',
      'Client.transferChannelOwnership',
      'TransferChannelOwnershipOptions.shouldDismissSelfAsAdmin'
    ]
  }
}

describe('ChannelsController operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const channels = (await collectOperations(MessagesModule)).filter(operation =>
      operation.id.startsWith('channels.')
    )

    expect(
      Object.fromEntries(channels.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })

  // Posting is the only channels operation that reaches other people: it needs `send`, not `manage`
  it('keeps the post of a channel on the send scope', async () => {
    const operations = await collectOperations(MessagesModule)

    expect(operations.find(op => op.id === 'channels.post')?.scope).toBe('send')
  })

  // The post can carry media as base64, so its route takes the larger body and is paid for before the
  // body is read (large-body-auth.hook.ts)
  it('gives the post of a channel the body limit of the send routes', () => {
    expect(SEND_ROUTES.has('/v1/sessions/:sessionId/channels/:channelId/messages')).toBe(true)
  })
})
