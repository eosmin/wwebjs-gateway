import { NotFoundError, ValidationError, WhatsAppError } from '../common/errors.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { GroupsService } from './groups.service.js'
import type { MediaResolverService } from './media-resolver.service.js'

const ok = (value: unknown = undefined) => jest.fn(() => Promise.resolve(value))

const build = (
  client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>,
  resolve: jest.Mock = jest.fn()
) => {
  const requireReady = jest.fn(() => client)
  return {
    service: new GroupsService(
      { requireReady } as unknown as SessionManager,
      { resolve } as unknown as MediaResolverService
    ),
    requireReady
  }
}

const group = { id: 'g@g.us', isGroup: true, participants: [] }
const privateChat = { id: 'a@c.us', isGroup: false }

describe('GroupsService reads', () => {
  it('lists only the groups among the chats', async () => {
    const { service } = build({
      getChats: ok([privateChat, group, { id: 'n@newsletter', isGroup: false, participants: [] }])
    })

    await expect(service.list('s')).resolves.toEqual([group])
  })

  it('reads a group, and answers 404 for a chat that is not one', async () => {
    const getChatById = jest.fn((id: string) =>
      Promise.resolve(id === 'g@g.us' ? group : privateChat)
    )
    const { service } = build({ getChatById })

    await expect(service.get('s', 'g@g.us')).resolves.toEqual(group)
    await expect(service.get('s', 'a@c.us')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('does not call the client when the session is not ready', () => {
    const getChats = ok([])
    const requireReady = jest.fn(() => {
      throw new Error('not ready')
    })
    const service = new GroupsService({ requireReady } as unknown as SessionManager, {} as never)

    expect(() => service.inviteCode('s', 'g@g.us')).toThrow('not ready')
    expect(getChats).not.toHaveBeenCalled()
  })
})

describe('GroupsService create and participants', () => {
  it('creates a group, leaving out the options that were not given', async () => {
    const createGroup = ok({ title: 'G', gid: 'g@g.us', participants: {} })
    const { service } = build({ createGroup })

    await service.create('s', {
      subject: 'G',
      participants: ['a@c.us'],
      isAnnounce: false,
      comment: undefined
    })

    expect(createGroup).toHaveBeenCalledWith('G', ['a@c.us'], { isAnnounce: false })
  })

  it('answers WHATSAPP_ERROR when wwebjs answers a text instead of the group', async () => {
    const { service } = build({ createGroup: ok('CreateGroupError: nope') })

    await expect(
      service.create('s', { subject: 'G', participants: ['a@c.us'] })
    ).rejects.toBeInstanceOf(WhatsAppError)
  })

  it('adds participants and answers what WhatsApp said for each', async () => {
    const outcome = { 'a@c.us': { code: 200, message: 'ok', isInviteV4Sent: false } }
    const addParticipants = ok(outcome)
    const { service } = build({ addParticipants })

    await expect(
      service.participants('s', 'g@g.us', {
        action: 'add',
        participants: ['a@c.us'],
        options: { sleep: 0, comment: undefined }
      })
    ).resolves.toEqual({ participants: outcome })
    expect(addParticipants).toHaveBeenCalledWith('g@g.us', ['a@c.us'], { sleep: 0 })
  })

  it('answers WHATSAPP_ERROR when adding answers a text', async () => {
    const { service } = build({ addParticipants: ok('Not an admin') })

    await expect(
      service.participants('s', 'g@g.us', { action: 'add', participants: ['a@c.us'] })
    ).rejects.toBeInstanceOf(WhatsAppError)
  })

  it.each([
    ['remove', 'removeParticipants'],
    ['promote', 'promoteParticipants'],
    ['demote', 'demoteParticipants']
  ] as const)('%s calls %s and answers the status', async (action, call) => {
    const stub = ok({ status: 200 })
    const { service } = build({ [call]: stub })

    await expect(
      service.participants('s', 'g@g.us', { action, participants: ['a@c.us'] })
    ).resolves.toEqual({ status: 200 })
    expect(stub).toHaveBeenCalledWith('g@g.us', ['a@c.us'])
  })
})

describe('GroupsService changes', () => {
  it('sets the subject and then the description, only those given', async () => {
    const order: string[] = []
    const setGroupSubject = jest.fn(() => {
      order.push('subject')
      return Promise.resolve(true)
    })
    const setGroupDescription = jest.fn(() => {
      order.push('description')
      return Promise.resolve(true)
    })
    const { service } = build({ setGroupSubject, setGroupDescription })

    await service.update('s', 'g@g.us', { description: 'd', subject: 'x' })
    expect(order).toEqual(['subject', 'description'])

    await service.update('s', 'g@g.us', { description: '' })
    expect(setGroupSubject).toHaveBeenCalledTimes(1)
    expect(setGroupDescription).toHaveBeenLastCalledWith('g@g.us', '')
  })

  it('stops at the first change WhatsApp refuses', async () => {
    const setGroupDescription = ok(true)
    const { service } = build({ setGroupSubject: ok(false), setGroupDescription })

    await expect(
      service.update('s', 'g@g.us', { subject: 'x', description: 'd' })
    ).rejects.toBeInstanceOf(WhatsAppError)
    expect(setGroupDescription).not.toHaveBeenCalled()
  })

  it('applies each setting given, false included, and no other', async () => {
    const setMessagesAdminsOnly = ok(true)
    const setInfoAdminsOnly = ok(true)
    const setAddMembersAdminsOnly = ok(true)
    const { service } = build({ setMessagesAdminsOnly, setInfoAdminsOnly, setAddMembersAdminsOnly })

    await service.settings('s', 'g@g.us', { infoAdminsOnly: false })

    expect(setInfoAdminsOnly).toHaveBeenCalledWith('g@g.us', false)
    expect(setMessagesAdminsOnly).not.toHaveBeenCalled()
    expect(setAddMembersAdminsOnly).not.toHaveBeenCalled()
  })

  it('answers WHATSAPP_ERROR when a setting is refused', async () => {
    const { service } = build({ setMessagesAdminsOnly: ok(false) })

    await expect(
      service.settings('s', 'g@g.us', { messagesAdminsOnly: true })
    ).rejects.toBeInstanceOf(WhatsAppError)
  })
})

describe('GroupsService picture', () => {
  it('sets an image', async () => {
    const picture = { mimetype: 'image/png', data: 'AA==' }
    const setGroupPicture = ok(true)
    const { service } = build({ setGroupPicture }, ok(picture))

    await service.setPicture('s', 'g@g.us', { url: 'https://example.com/a.png' })

    expect(setGroupPicture).toHaveBeenCalledWith('g@g.us', picture)
  })

  it('refuses what is not an image before calling WhatsApp', async () => {
    const setGroupPicture = ok(true)
    const { service } = build(
      { setGroupPicture },
      ok({ mimetype: 'application/pdf', data: 'AA==' })
    )

    await expect(
      service.setPicture('s', 'g@g.us', { url: 'https://example.com/a.pdf' })
    ).rejects.toBeInstanceOf(ValidationError)
    expect(setGroupPicture).not.toHaveBeenCalled()
  })

  it('answers WHATSAPP_ERROR when WhatsApp does not delete the picture', async () => {
    const { service } = build({ deleteGroupPicture: ok(false) })

    await expect(service.deletePicture('s', 'g@g.us')).rejects.toBeInstanceOf(WhatsAppError)
  })
})

describe('GroupsService requests and invites', () => {
  it('answers the requests to enter with the options given only', async () => {
    const approve = ok([{ requesterId: 'a@c.us', message: 'ok' }])
    const reject = ok([])
    const { service } = build({
      approveGroupMembershipRequests: approve,
      rejectGroupMembershipRequests: reject
    })

    await service.approveRequests('s', 'g@g.us', { requesterIds: 'a@c.us', sleep: undefined })
    await service.rejectRequests('s', 'g@g.us', {})

    expect(approve).toHaveBeenCalledWith('g@g.us', { requesterIds: 'a@c.us' })
    expect(reject).toHaveBeenCalledWith('g@g.us', {})
  })

  it('joins by code and reads the invite', async () => {
    const acceptInvite = ok('g@g.us')
    const getInviteInfo = ok({ subject: 'G' })
    const { service } = build({ acceptInvite, getInviteInfo })

    await expect(service.join('s', 'CODE')).resolves.toBe('g@g.us')
    await expect(service.inviteInfo('s', 'CODE')).resolves.toEqual({ subject: 'G' })
  })

  it('revokes the invite and leaves', async () => {
    const revokeGroupInvite = ok()
    const leaveGroup = ok()
    const { service } = build({ revokeGroupInvite, leaveGroup })

    await service.revokeInvite('s', 'g@g.us')
    await service.leave('s', 'g@g.us')

    expect(revokeGroupInvite).toHaveBeenCalledWith('g@g.us')
    expect(leaveGroup).toHaveBeenCalledWith('g@g.us')
  })
})

describe('GroupsService refusals', () => {
  it.each([
    ['remove', 'removeParticipants'],
    ['promote', 'promoteParticipants'],
    ['demote', 'demoteParticipants']
  ] as const)(
    '%s answers WHATSAPP_ERROR when WhatsApp gives a status that is not 2xx',
    async (action, call) => {
      const { service } = build({ [call]: ok({ status: 403 }) })

      await expect(
        service.participants('s', 'g@g.us', { action, participants: ['a@c.us'] })
      ).rejects.toMatchObject({ code: 'WHATSAPP_ERROR', details: { status: 403 } })
    }
  )

  it('tells which parts of an update were applied when a later one fails', async () => {
    const { service } = build({ setGroupSubject: ok(true), setGroupDescription: ok(false) })

    await expect(
      service.update('s', 'g@g.us', { subject: 'x', description: 'd' })
    ).rejects.toMatchObject({ details: { failed: 'description', applied: ['subject'] } })
  })

  it('tells which settings were applied when a later one fails', async () => {
    const { service } = build({
      setMessagesAdminsOnly: ok(true),
      setInfoAdminsOnly: ok(false),
      setAddMembersAdminsOnly: ok(true)
    })

    await expect(
      service.settings('s', 'g@g.us', {
        messagesAdminsOnly: true,
        infoAdminsOnly: true,
        addMembersAdminsOnly: true
      })
    ).rejects.toMatchObject({
      details: { failed: 'infoAdminsOnly', applied: ['messagesAdminsOnly'] }
    })
  })
})
