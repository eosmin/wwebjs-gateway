import { ConflictError } from '../common/errors.js'
import type { MessageDto } from '../types/dto.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { PollsEventsService } from './polls-events.service.js'

const INVITE = {
  inviteCode: 'ABCDEF',
  inviteCodeExp: 1_767_225_600,
  groupId: '120363000000000001@g.us',
  fromId: 'a@c.us',
  toId: 'b@c.us'
}
const POLL = { id: 'm', type: 'poll_creation', pollOptions: ['Martes', 'Jueves'] } as MessageDto
const EVENT = { id: 'm', type: 'scheduled_event_creation', fromMe: true } as MessageDto
const START = '2026-02-01T18:00:00.000Z'

const build = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>) => {
  const requireReady = jest.fn(() => client)
  return {
    service: new PollsEventsService({ requireReady } as unknown as SessionManager),
    requireReady
  }
}

describe('PollsEventsService', () => {
  describe('pollVotes and vote', () => {
    it('reads the votes of a poll, and refuses a message that is not one or does not exist', async () => {
      const getPollVotes = jest.fn(() => Promise.resolve([]))
      const getMessageById = jest
        .fn()
        .mockResolvedValueOnce(POLL)
        .mockResolvedValueOnce(EVENT)
        .mockResolvedValueOnce(null)
      const { service } = build({ getPollVotes, getMessageById })

      await expect(service.pollVotes('s', 'm')).resolves.toEqual([])
      await expect(service.pollVotes('s', 'm')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      await expect(service.pollVotes('s', 'm')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(getPollVotes).toHaveBeenCalledTimes(1)
    })

    it('votes for names that are options, and for none to remove the vote', async () => {
      const vote = jest.fn(() => Promise.resolve())
      const { service } = build({ vote, getMessageById: jest.fn(() => Promise.resolve(POLL)) })

      await service.vote('s', 'm', ['Martes'])
      await service.vote('s', 'm', [])

      expect(vote.mock.calls).toEqual([
        ['m', ['Martes']],
        ['m', []]
      ])
    })

    it('refuses a name that is not an option, with the names in the details', async () => {
      const vote = jest.fn()
      const { service } = build({ vote, getMessageById: jest.fn(() => Promise.resolve(POLL)) })

      await expect(service.vote('s', 'm', ['Martes', 'Lunes'])).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { unknownOptions: ['Lunes'] }
      })
      expect(vote).not.toHaveBeenCalled()
    })

    it('lists every unknown name, and treats a poll without options as having none', async () => {
      const vote = jest.fn()
      const { service } = build({ vote, getMessageById: jest.fn(() => Promise.resolve(POLL)) })
      const bare = build({
        vote,
        getMessageById: jest.fn(() => Promise.resolve({ id: 'm', type: 'poll_creation' }))
      }).service

      await expect(service.vote('s', 'm', ['Lunes', 'Viernes', 'Martes'])).rejects.toMatchObject({
        details: { unknownOptions: ['Lunes', 'Viernes'] }
      })
      await expect(bare.vote('s', 'm', ['Martes'])).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
      await expect(bare.vote('s', 'm', [])).resolves.toBeUndefined()
      expect(vote).toHaveBeenCalledTimes(1)
    })
  })

  it.each([
    ['pollVotes', (s: PollsEventsService) => s.pollVotes('s', 'm')],
    ['vote', (s: PollsEventsService) => s.vote('s', 'm', [])],
    ['respondToEvent', (s: PollsEventsService) => s.respondToEvent('s', 'm', 1)],
    [
      'editEvent',
      (s: PollsEventsService) => s.editEvent('s', 'm', { name: 'x', startTime: START })
    ],
    ['acceptGroupInvite', (s: PollsEventsService) => s.acceptGroupInvite('s', 'm')]
  ])('%s lets the error of a session that is not ready through', async (_name, run) => {
    const service = new PollsEventsService({
      requireReady: jest.fn(() => {
        throw new ConflictError('SESSION_NOT_READY', 'Session s is stopped, not ready')
      })
    } as unknown as SessionManager)

    await expect(run(service)).rejects.toMatchObject({ code: 'SESSION_NOT_READY' })
  })

  describe('respondToEvent', () => {
    it('sends the response before the message id, for either event type', async () => {
      const sendResponseToScheduledEvent = jest.fn(() => Promise.resolve(true))
      const getMessageById = jest
        .fn()
        .mockResolvedValueOnce(EVENT)
        .mockResolvedValueOnce({ ...EVENT, type: 'event_creation' })
      const { service } = build({ sendResponseToScheduledEvent, getMessageById })
      await service.respondToEvent('s', 'm', 1)

      await service.respondToEvent('s', 'm', 3)

      expect(sendResponseToScheduledEvent).toHaveBeenCalledWith(3, 'm')
    })

    it('answers NOT_FOUND when the response is not delivered', async () => {
      const { service } = build({
        sendResponseToScheduledEvent: jest.fn(() => Promise.resolve(false)),
        getMessageById: jest.fn(() => Promise.resolve(EVENT))
      })

      await expect(service.respondToEvent('s', 'm', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('refuses a message that is not an event, without sending', async () => {
      const sendResponseToScheduledEvent = jest.fn()
      const { service } = build({
        sendResponseToScheduledEvent,
        getMessageById: jest.fn(() => Promise.resolve({ id: 'm', type: 'chat' }))
      })

      await expect(service.respondToEvent('s', 'm', 1)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
      expect(sendResponseToScheduledEvent).not.toHaveBeenCalled()
    })
  })

  describe('editEvent', () => {
    const edit = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>, body = {}) =>
      build(client).service.editEvent('s', 'm', { name: 'Entrega', startTime: START, ...body })

    it('leaves out what was not sent, and turns the dates into Date', async () => {
      const editScheduledEvent = jest.fn(() => Promise.resolve({ id: 'm' } as MessageDto))

      await edit({ editScheduledEvent, getMessageById: jest.fn(() => Promise.resolve(EVENT)) })

      expect(editScheduledEvent).toHaveBeenCalledWith('m', {
        type: 'event',
        name: 'Entrega',
        startTime: new Date(START)
      })
    })

    it('keeps a canceled flag of false and an empty description', async () => {
      const editScheduledEvent = jest.fn(() => Promise.resolve({ id: 'm' } as MessageDto))

      await edit(
        { editScheduledEvent, getMessageById: jest.fn(() => Promise.resolve(EVENT)) },
        { isEventCanceled: false, description: '', endTime: '2026-02-01T19:00:00.000Z' }
      )

      expect(editScheduledEvent).toHaveBeenCalledWith('m', {
        type: 'event',
        name: 'Entrega',
        startTime: new Date(START),
        endTime: new Date('2026-02-01T19:00:00.000Z'),
        description: '',
        isEventCanceled: false
      })
    })

    it('refuses an event of somebody else, a message that is not an event and a missing one', async () => {
      const editScheduledEvent = jest.fn()
      const getMessageById = jest
        .fn()
        .mockResolvedValueOnce({ ...EVENT, fromMe: false })
        .mockResolvedValueOnce(POLL)
        .mockResolvedValueOnce(null)

      await expect(edit({ editScheduledEvent, getMessageById })).rejects.toMatchObject({
        code: 'WHATSAPP_ERROR'
      })
      await expect(edit({ editScheduledEvent, getMessageById })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
      await expect(edit({ editScheduledEvent, getMessageById })).rejects.toMatchObject({
        code: 'NOT_FOUND'
      })
      expect(editScheduledEvent).not.toHaveBeenCalled()
    })

    it('fails with WHATSAPP_ERROR when WhatsApp does not edit the event', async () => {
      await expect(
        edit({
          editScheduledEvent: jest.fn(() => Promise.resolve(null)),
          getMessageById: jest.fn(() => Promise.resolve(EVENT))
        })
      ).rejects.toMatchObject({ code: 'WHATSAPP_ERROR' })
    })
  })

  describe('acceptGroupInvite', () => {
    const accept = (message: unknown) => {
      const acceptGroupV4Invite = jest.fn(() => Promise.resolve({ status: 200 }))
      const getMessageById = jest.fn(() => Promise.resolve(message))
      return {
        acceptGroupV4Invite,
        getMessageById,
        run: () =>
          build({ acceptGroupV4Invite, getMessageById }).service.acceptGroupInvite('s', 'm')
      }
    }

    it('accepts the invite the message carries', async () => {
      const { run, acceptGroupV4Invite, getMessageById } = accept({ inviteV4: INVITE })

      await expect(run()).resolves.toEqual({ status: 200 })
      expect(getMessageById).toHaveBeenCalledWith('m')
      expect(acceptGroupV4Invite).toHaveBeenCalledWith(INVITE)
    })

    it.each([
      ['has no invite', {}, 'NOT_FOUND'],
      ['does not exist', null, 'NOT_FOUND'],
      [
        'carries an expired invite',
        { inviteV4: { ...INVITE, inviteCodeExp: 0 } },
        'VALIDATION_ERROR'
      ]
    ])('refuses a message that %s, without joining', async (_label, message, code) => {
      const { run, acceptGroupV4Invite } = accept(message)

      await expect(run()).rejects.toMatchObject({ code })
      expect(acceptGroupV4Invite).not.toHaveBeenCalled()
    })
  })
})
