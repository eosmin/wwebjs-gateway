import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// The scope of every send policy operation is pinned: reading is `read`, changing is `manage`
const EXPECTED: Record<string, string> = {
  'sendPolicy.get': 'read',
  'sendPolicy.update': 'manage',
  'sendPolicy.usage': 'read',
  'suppressions.list': 'read',
  'suppressions.add': 'manage',
  'suppressions.remove': 'manage',
  'unreachableChats.list': 'read'
}

describe('send policy operations', () => {
  it('declares exactly the operations of the table, gateway-native, each with its scope', async () => {
    const operations = (await collectOperations(MessagesModule)).filter(operation =>
      /^(sendPolicy|suppressions|unreachableChats)\./.test(operation.id)
    )

    expect(Object.fromEntries(operations.map(op => [op.id, op.scope]))).toEqual(EXPECTED)
    for (const operation of operations) {
      expect(operation.gateway).toBe(true)
      expect(operation.wwebjs).toEqual([])
    }
  })
})
