import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// The scope and the wwebjs symbols of every lookup operation are pinned
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'numbers.lookup': {
    scope: 'read',
    wwebjs: [
      'Client.getNumberId',
      'Client.isRegisteredUser',
      'Client.getCountryCode',
      'Client.getFormattedNumber'
    ]
  },
  'contacts.lidPhone': { scope: 'read', wwebjs: ['Client.getContactLidAndPhone'] }
}

describe('lookup operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const operations = (await collectOperations(MessagesModule)).filter(operation =>
      /^(numbers|contacts)\./.test(operation.id)
    )

    expect(
      Object.fromEntries(operations.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })
})
