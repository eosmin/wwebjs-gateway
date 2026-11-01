import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope and the wwebjs symbols of every broadcasts operation
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'broadcasts.list': {
    scope: 'read',
    wwebjs: [
      'Client.getBroadcasts',
      'Broadcast.id',
      'Broadcast.timestamp',
      'Broadcast.totalCount',
      'Broadcast.unreadCount',
      'Broadcast.msgs'
    ]
  },
  'broadcasts.get': { scope: 'read', wwebjs: ['Client.getBroadcastById'] }
}

describe('BroadcastsController operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const broadcasts = (await collectOperations(MessagesModule)).filter(operation =>
      operation.id.startsWith('broadcasts.')
    )

    expect(
      Object.fromEntries(broadcasts.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })
})
