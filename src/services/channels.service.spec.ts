import { NotFoundError, ValidationError, WhatsAppError } from '../common/errors.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { ChannelsService } from './channels.service.js'
import type { MediaResolverService } from './media-resolver.service.js'

const ok = (value: unknown = undefined) => jest.fn(() => Promise.resolve(value))

const build = (
  client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>,
  resolve: jest.Mock = jest.fn()
) => {
  const requireReady = jest.fn(() => client)
  return {
    service: new ChannelsService(
      { requireReady } as unknown as SessionManager,
      { resolve } as unknown as MediaResolverService
    ),
    requireReady
  }
}

const CHANNEL = '120363000000000001@newsletter'
const channel = { id: CHANNEL, isChannel: true, isGroup: false }
const privateChat = { id: 'a@c.us', isGroup: false }

describe('ChannelsService reads', () => {
  it('reads a channel, and answers 404 for a chat that is not one', async () => {
    const getChatById = jest.fn((id: string) =>
      Promise.resolve(id === CHANNEL ? channel : privateChat)
    )
    const { service } = build({ getChatById })

    await expect(service.get('s', CHANNEL)).resolves.toEqual(channel)
    await expect(service.get('s', 'a@c.us')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('searches with the options that were given only', async () => {
    const searchChannels = ok([])
    const { service } = build({ searchChannels })

    await service.search('s', { searchText: 'moda', countryCodes: undefined, limit: 5 })

    expect(searchChannels).toHaveBeenCalledWith({ searchText: 'moda', limit: 5 })
  })

  it('asks for the subscribers and the posts of the channel with the limits of the request', async () => {
    const getChannelSubscribers = ok([])
    const fetchChannelMessages = ok([])
    const { service } = build({ getChannelSubscribers, fetchChannelMessages })

    await service.subscribers('s', CHANNEL, 20)
    await service.messages('s', CHANNEL, { limit: 10, fromMe: undefined })

    expect(getChannelSubscribers).toHaveBeenCalledWith(CHANNEL, 20)
    expect(fetchChannelMessages).toHaveBeenCalledWith(CHANNEL, { limit: 10 })
  })

  it('does not call the client when the session is not ready', () => {
    const requireReady = jest.fn(() => {
      throw new Error('not ready')
    })
    const service = new ChannelsService({ requireReady } as unknown as SessionManager, {} as never)

    expect(() => service.list('s')).toThrow('not ready')
  })
})

describe('ChannelsService create', () => {
  it('creates a channel with a picture that is an image', async () => {
    const createChannel = ok({ title: 'N', nid: CHANNEL, inviteLink: 'l', createdAtTs: 1 })
    const picture = { mimetype: 'image/png', data: 'QUJD' }
    const { service } = build(
      { createChannel },
      jest.fn(() => Promise.resolve(picture))
    )

    await service.create('s', {
      name: 'N',
      description: 'D',
      picture: { base64: 'QUJD', mimetype: 'image/png' }
    })

    expect(createChannel).toHaveBeenCalledWith('N', { description: 'D', picture })
  })

  it('refuses a picture that is not an image before WhatsApp sees anything', async () => {
    const createChannel = ok()
    const { service } = build(
      { createChannel },
      jest.fn(() => Promise.resolve({ mimetype: 'video/mp4', data: 'QUJD' }))
    )

    await expect(
      service.create('s', { name: 'N', picture: { url: 'https://example.com/v.mp4' } })
    ).rejects.toBeInstanceOf(ValidationError)
    expect(createChannel).not.toHaveBeenCalled()
  })

  it('answers WHATSAPP_ERROR with the reason when wwebjs answers a text', async () => {
    const { service } = build({ createChannel: ok('CreateChannelError: nope') })

    await expect(service.create('s', { name: 'N' })).rejects.toMatchObject({
      code: 'WHATSAPP_ERROR',
      details: { reason: 'CreateChannelError: nope' }
    })
  })
})

describe('ChannelsService changes', () => {
  it('applies the name and then the description', async () => {
    const order: string[] = []
    const setChannelSubject = jest.fn(() => Promise.resolve(order.push('name') > 0))
    const setChannelDescription = jest.fn(() => Promise.resolve(order.push('description') > 0))
    const { service } = build({ setChannelSubject, setChannelDescription })

    await service.update('s', CHANNEL, { name: 'N', description: 'D' })

    expect(order).toEqual(['name', 'description'])
  })

  it('says what was applied when the second change is refused', async () => {
    const { service } = build({
      setChannelSubject: ok(true),
      setChannelDescription: ok(false)
    })

    await expect(
      service.update('s', CHANNEL, { name: 'N', description: 'D' })
    ).rejects.toMatchObject({
      code: 'WHATSAPP_ERROR',
      details: { failed: 'description', applied: ['name'] }
    })
  })

  it('maps the reaction setting to the code wwebjs documents', async () => {
    const setChannelReactionSetting = ok(true)
    const { service } = build({ setChannelReactionSetting })

    await service.setReactionSetting('s', CHANNEL, { setting: 'none' })
    await service.setReactionSetting('s', CHANNEL, { setting: 'basic' })
    await service.setReactionSetting('s', CHANNEL, { setting: 'all' })

    expect(setChannelReactionSetting.mock.calls).toEqual([
      [CHANNEL, 0],
      [CHANNEL, 1],
      [CHANNEL, 2]
    ])
  })

  it.each([
    ['delete', (s: ChannelsService) => s.delete('s', CHANNEL), 'deleteChannel'],
    ['subscribe', (s: ChannelsService) => s.subscribe('s', CHANNEL), 'subscribeToChannel'],
    [
      'unsubscribe',
      (s: ChannelsService) => s.unsubscribe('s', CHANNEL, {}),
      'unsubscribeFromChannel'
    ],
    ['mute', (s: ChannelsService) => s.mute('s', CHANNEL), 'muteChannel'],
    ['unmute', (s: ChannelsService) => s.unmute('s', CHANNEL), 'unmuteChannel'],
    [
      'accept the admin invite',
      (s: ChannelsService) => s.acceptAdminInvite('s', CHANNEL),
      'acceptChannelAdminInvite'
    ],
    [
      'revoke the admin invite',
      (s: ChannelsService) => s.revokeAdminInvite('s', CHANNEL, 'a@c.us'),
      'revokeChannelAdminInvite'
    ],
    [
      'demote an admin',
      (s: ChannelsService) => s.demoteAdmin('s', CHANNEL, 'a@c.us'),
      'demoteChannelAdmin'
    ]
  ] as const)('answers WHATSAPP_ERROR when WhatsApp refuses to %s', async (_name, act, method) => {
    const { service } = build({ [method]: ok(false) })

    await expect(act(service)).rejects.toBeInstanceOf(WhatsAppError)
  })

  it('invites an admin: the user is the chat of the invitation', async () => {
    const sendChannelAdminInvite = ok(true)
    const { service } = build({ sendChannelAdminInvite })

    await service.inviteAdmin('s', CHANNEL, { userId: 'a@c.us', comment: 'hola' })

    expect(sendChannelAdminInvite).toHaveBeenCalledWith('a@c.us', CHANNEL, { comment: 'hola' })
  })

  it('transfers the ownership, leaving out the option that was not given', async () => {
    const transferChannelOwnership = ok(true)
    const { service } = build({ transferChannelOwnership })

    await service.transferOwnership('s', CHANNEL, { newOwnerId: 'a@c.us' })

    expect(transferChannelOwnership).toHaveBeenCalledWith(CHANNEL, 'a@c.us', {})
  })
})
