import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope and the wwebjs symbols of every contacts operation
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'contacts.list': { scope: 'read', wwebjs: ['Client.getContacts'] },
  'contacts.blocked': { scope: 'read', wwebjs: ['Client.getBlockedContacts'] },
  'contacts.get': { scope: 'read', wwebjs: ['Client.getContactById', 'Broadcast.getContact'] },
  'contacts.about': { scope: 'read', wwebjs: ['Contact.getAbout'] },
  'contacts.picture': {
    scope: 'read',
    wwebjs: ['Client.getProfilePicUrl', 'Contact.getProfilePicUrl']
  },
  'contacts.commonGroups': {
    scope: 'read',
    wwebjs: ['Client.getCommonGroups', 'Contact.getCommonGroups']
  },
  'contacts.deviceCount': { scope: 'read', wwebjs: ['Client.getContactDeviceCount'] },
  'contacts.broadcast': { scope: 'read', wwebjs: ['Contact.getBroadcast'] },
  'contacts.block': { scope: 'manage', wwebjs: ['Contact.block'] },
  'contacts.unblock': { scope: 'manage', wwebjs: ['Contact.unblock'] },
  'contacts.saveAddressbook': {
    scope: 'manage',
    wwebjs: ['Client.saveOrEditAddressbookContact']
  },
  'contacts.deleteAddressbook': {
    scope: 'manage',
    wwebjs: ['Client.deleteAddressbookContact']
  }
}

describe('ContactsController operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    // contacts.lidPhone belongs to the lookup controller
    const contacts = (await collectOperations(MessagesModule)).filter(
      operation => operation.id.startsWith('contacts.') && operation.id !== 'contacts.lidPhone'
    )

    expect(
      Object.fromEntries(contacts.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })
})
