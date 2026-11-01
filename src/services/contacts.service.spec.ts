import { WhatsAppError } from '../common/errors.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { ContactsService } from './contacts.service.js'

const ok = (value: unknown = undefined) => jest.fn(() => Promise.resolve(value))

const build = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>) => {
  const requireReady = jest.fn(() => client)
  return {
    service: new ContactsService({ requireReady } as unknown as SessionManager),
    requireReady
  }
}

describe('ContactsService', () => {
  it('reads through the client of a ready session', async () => {
    const getContacts = ok([{ id: 'a@c.us' }])
    const getBlockedContacts = ok([{ id: 'b@c.us' }])
    const getContactById = ok({ id: 'a@c.us' })
    const getContactAbout = ok('hi')
    const getProfilePicUrl = ok(null)
    const getCommonGroups = ok(['g@g.us'])
    const getContactDeviceCount = ok(2)
    const { service, requireReady } = build({
      getContacts,
      getBlockedContacts,
      getContactById,
      getContactAbout,
      getProfilePicUrl,
      getCommonGroups,
      getContactDeviceCount
    })

    await expect(service.list('s')).resolves.toEqual([{ id: 'a@c.us' }])
    await expect(service.blocked('s')).resolves.toEqual([{ id: 'b@c.us' }])
    await expect(service.get('s', 'a@c.us')).resolves.toEqual({ id: 'a@c.us' })
    await expect(service.about('s', 'a@c.us')).resolves.toBe('hi')
    await expect(service.picture('s', 'a@c.us')).resolves.toBeNull()
    await expect(service.commonGroups('s', 'a@c.us')).resolves.toEqual(['g@g.us'])
    await expect(service.deviceCount('s', 'a@c.us')).resolves.toBe(2)
    expect(requireReady).toHaveBeenCalledWith('s')
    expect(getContactById).toHaveBeenCalledWith('a@c.us')
  })

  it('does not call the client when the session is not ready', () => {
    const getContacts = ok([])
    const requireReady = jest.fn(() => {
      throw new Error('not ready')
    })
    const service = new ContactsService({ requireReady } as unknown as SessionManager)

    expect(() => service.list('s')).toThrow('not ready')
    expect(getContacts).not.toHaveBeenCalled()
  })

  it.each([
    ['block', 'blockContact'],
    ['unblock', 'unblockContact']
  ] as const)('%s answers WHATSAPP_ERROR when WhatsApp did not do it', async (method, call) => {
    const { service } = build({ [call]: ok(false) })

    await expect(service[method]('s', 'a@c.us')).rejects.toBeInstanceOf(WhatsAppError)
  })

  it.each([
    ['block', 'blockContact'],
    ['unblock', 'unblockContact']
  ] as const)('%s resolves when WhatsApp did it', async (method, call) => {
    const stub = ok(true)
    const { service } = build({ [call]: stub })

    await expect(service[method]('s', 'a@c.us')).resolves.toBeUndefined()
    expect(stub).toHaveBeenCalledWith('a@c.us')
  })

  it('passes no syncToAddressbook when it is not given, so the wwebjs default applies', async () => {
    const save = ok()
    const { service } = build({ saveOrEditAddressbookContact: save })

    await service.saveAddressbook('s', '5215500000001', { firstName: 'A', lastName: 'B' })

    expect(save).toHaveBeenCalledWith('5215500000001', 'A', 'B', undefined)
  })

  it('passes syncToAddressbook when it is given, false included', async () => {
    const save = ok()
    const { service } = build({ saveOrEditAddressbookContact: save })

    await service.saveAddressbook('s', '5215500000001', {
      firstName: 'A',
      lastName: '',
      syncToAddressbook: false
    })

    expect(save).toHaveBeenCalledWith('5215500000001', 'A', '', false)
  })

  it('deletes an address book entry by phone number', async () => {
    const del = ok()
    const { service } = build({ deleteAddressbookContact: del })

    await service.deleteAddressbook('s', '5215500000001')

    expect(del).toHaveBeenCalledWith('5215500000001')
  })
})
