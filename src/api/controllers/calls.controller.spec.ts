import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope and the wwebjs symbols of every calls operation
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'calls.createLink': { scope: 'manage', wwebjs: ['Client.createCallLink'] },
  'calls.reject': {
    scope: 'manage',
    wwebjs: [
      'Call.reject',
      'Call.id',
      'Call.from',
      'Call.timestamp',
      'Call.isVideo',
      'Call.isGroup',
      'Call.fromMe',
      'Call.canHandleLocally',
      'Call.webClientShouldHandle',
      'Call.participants'
    ]
  }
}

describe('CallsController operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const calls = (await collectOperations(MessagesModule)).filter(operation =>
      operation.id.startsWith('calls.')
    )

    expect(
      Object.fromEntries(calls.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })
})
