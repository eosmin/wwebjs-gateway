import { collectOperations } from '../../parity/operation-links.js'
import { MessagesModule } from '../messages.module.js'

// The scope and the wwebjs symbols of every presence, profile and settings operation are pinned:
// a wrong scope would let a key reach what it must not
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'presence.set': {
    scope: 'manage',
    wwebjs: ['Client.sendPresenceAvailable', 'Client.sendPresenceUnavailable']
  },
  'profile.setStatus': { scope: 'manage', wwebjs: ['Client.setStatus'] },
  'profile.setDisplayName': { scope: 'manage', wwebjs: ['Client.setDisplayName'] },
  'profile.setPicture': { scope: 'manage', wwebjs: ['Client.setProfilePicture'] },
  'profile.deletePicture': { scope: 'manage', wwebjs: ['Client.deleteProfilePicture'] },
  'settings.update': {
    scope: 'manage',
    wwebjs: [
      'Client.setAutoDownloadAudio',
      'Client.setAutoDownloadDocuments',
      'Client.setAutoDownloadPhotos',
      'Client.setAutoDownloadVideos',
      'Client.setBackgroundSync'
    ]
  }
}

describe('presence, profile and settings operations', () => {
  it('declares exactly the operations of the table, each with its scope and wwebjs symbols', async () => {
    const operations = (await collectOperations(MessagesModule)).filter(operation =>
      /^(presence|profile|settings)\./.test(operation.id)
    )

    expect(
      Object.fromEntries(operations.map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }]))
    ).toEqual(EXPECTED)
  })
})
