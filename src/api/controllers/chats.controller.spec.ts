import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope and the wwebjs symbols of every chats operation
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'chats.list': { scope: 'read', wwebjs: ['Client.getChats'] },
  'chats.get': { scope: 'read', wwebjs: ['Client.getChatById'] },
  'chats.messages': { scope: 'read', wwebjs: ['Chat.fetchMessages'] },
  'chats.pinnedMessages': {
    scope: 'read',
    wwebjs: ['Chat.getPinnedMessages', 'Client.getPinnedMessages']
  },
  'chats.setState': {
    scope: 'send',
    wwebjs: ['Chat.sendStateTyping', 'Chat.sendStateRecording', 'Chat.clearState']
  },
  'chats.seen': { scope: 'send', wwebjs: ['Chat.sendSeen', 'Client.sendSeen'] },
  'chats.markUnread': { scope: 'manage', wwebjs: ['Chat.markUnread', 'Client.markChatUnread'] },
  'chats.archive': { scope: 'manage', wwebjs: ['Chat.archive', 'Client.archiveChat'] },
  'chats.unarchive': { scope: 'manage', wwebjs: ['Chat.unarchive', 'Client.unarchiveChat'] },
  'chats.pin': { scope: 'manage', wwebjs: ['Chat.pin', 'Client.pinChat'] },
  'chats.unpin': { scope: 'manage', wwebjs: ['Chat.unpin', 'Client.unpinChat'] },
  'chats.mute': { scope: 'manage', wwebjs: ['Chat.mute', 'Client.muteChat'] },
  'chats.unmute': { scope: 'manage', wwebjs: ['Chat.unmute', 'Client.unmuteChat'] },
  'chats.clearMessages': { scope: 'manage', wwebjs: ['Chat.clearMessages'] },
  'chats.delete': { scope: 'manage', wwebjs: ['Chat.delete'] },
  'chats.syncHistory': { scope: 'manage', wwebjs: ['Chat.syncHistory', 'Client.syncHistory'] }
}

describe('ChatsController operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const chats = (await collectOperations(MessagesModule)).filter(operation =>
      operation.id.startsWith('chats.')
    )

    expect(
      Object.fromEntries(chats.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })

  it('exposes only chats.setState as a socket command, named chat.state', async () => {
    const chats = (await collectOperations(MessagesModule)).filter(operation =>
      operation.id.startsWith('chats.')
    )

    expect(
      chats.filter(op => op.socket !== undefined).map(op => [op.id, op.socket?.command])
    ).toEqual([['chats.setState', 'chat.state']])
  })

  it('shows a mute example the route accepts: the end is in the future', async () => {
    const mute = (await collectOperations(MessagesModule)).find(op => op.id === 'chats.mute')
    const until = (mute?.examples.request as { until: string }).until

    expect(new Date(until).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000)
  })
})
