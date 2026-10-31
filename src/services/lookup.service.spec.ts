import { ValidationError } from '../common/errors.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { LookupService } from './lookup.service.js'
import type { RecipientResolverService } from './recipient-resolver.service.js'

const build = (
  id: string | null,
  client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>> = {}
) => {
  const requireReady = jest.fn(() => client)
  const lookup = jest.fn(() => Promise.resolve(id))
  return {
    service: new LookupService(
      { requireReady } as unknown as SessionManager,
      { lookup } as unknown as RecipientResolverService
    ),
    lookup,
    requireReady
  }
}

describe('LookupService', () => {
  it('answers a registered number with its id, country code and format', async () => {
    const getCountryCode = jest.fn(() => Promise.resolve('52'))
    const getFormattedNumber = jest.fn(() => Promise.resolve('+52 1 55 0000 0001'))
    const { service, lookup } = build('5215500000001@c.us', { getCountryCode, getFormattedNumber })

    await expect(service.number('s', '+52 1 55-0000-0001')).resolves.toEqual({
      number: '5215500000001',
      registered: true,
      id: '5215500000001@c.us',
      countryCode: '52',
      formatted: '+52 1 55 0000 0001'
    })
    expect(lookup).toHaveBeenCalledWith('s', '5215500000001')
    expect(getCountryCode).toHaveBeenCalledWith('5215500000001')
  })

  it('answers a number without an account as not registered and asks the client nothing more', async () => {
    const getCountryCode = jest.fn()
    const { service } = build(null, { getCountryCode })

    await expect(service.number('s', '5215500000002')).resolves.toEqual({
      number: '5215500000002',
      registered: false,
      id: null,
      countryCode: null,
      formatted: null
    })
    expect(getCountryCode).not.toHaveBeenCalled()
  })

  it('needs a ready session even when the answer is cached', async () => {
    const { service, requireReady, lookup } = build(null)
    requireReady.mockImplementation(() => {
      throw new Error('SESSION_NOT_READY')
    })

    await expect(service.number('s', '5215500000002')).rejects.toThrow('SESSION_NOT_READY')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses text that is not a phone number before any look-up', async () => {
    const { service, lookup } = build('x@c.us')

    await expect(service.number('s', '5215500000001@c.us')).rejects.toBeInstanceOf(ValidationError)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('passes the ids to the client', async () => {
    const getContactLidAndPhone = jest.fn(() =>
      Promise.resolve([{ lid: '1@lid', pn: '5215500000001@c.us' }])
    )
    const { service } = build(null, { getContactLidAndPhone })

    await expect(service.lidAndPhone('s', ['1@lid'])).resolves.toEqual([
      { lid: '1@lid', pn: '5215500000001@c.us' }
    ])
    expect(getContactLidAndPhone).toHaveBeenCalledWith(['1@lid'])
  })

  it('keeps the side WhatsApp does not know as null and drops a pair with neither side', async () => {
    const getContactLidAndPhone = jest.fn(() =>
      Promise.resolve([
        { lid: '1@lid', pn: undefined },
        { lid: undefined, pn: '5215500000002@c.us' },
        { lid: undefined, pn: undefined },
        { lid: null, pn: null }
      ])
    )
    const { service } = build(null, { getContactLidAndPhone })

    await expect(
      service.lidAndPhone('s', ['1@lid', '5215500000002@c.us', '2@lid'])
    ).resolves.toEqual([
      { lid: '1@lid', pn: null },
      { lid: null, pn: '5215500000002@c.us' }
    ])
  })
})
