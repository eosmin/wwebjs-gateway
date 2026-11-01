import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope and the wwebjs symbols of every labels operation
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'labels.list': {
    scope: 'read',
    wwebjs: ['Client.getLabels', 'Label.id', 'Label.name', 'Label.hexColor']
  },
  'labels.get': { scope: 'read', wwebjs: ['Client.getLabelById'] },
  'labels.chats': { scope: 'read', wwebjs: ['Client.getChatsByLabelId', 'Label.getChats'] },
  'labels.assign': { scope: 'manage', wwebjs: ['Client.addOrRemoveLabels'] },
  'labels.ofChat': { scope: 'read', wwebjs: ['Client.getChatLabels', 'Chat.getLabels'] },
  'labels.setForChat': { scope: 'manage', wwebjs: ['Chat.changeLabels'] }
}

describe('LabelsController operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const labels = (await collectOperations(MessagesModule)).filter(operation =>
      operation.id.startsWith('labels.')
    )

    expect(
      Object.fromEntries(labels.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })
})
