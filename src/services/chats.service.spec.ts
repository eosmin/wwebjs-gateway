import type { GroupChatDto } from '../types/dto.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import { WaChatNotFoundError, WaOperationError } from '../whatsapp/wa-errors.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { ChatsService } from './chats.service.js'

const CHAT = '5215500000001@c.us'
const NOW = new Date('2026-01-01T00:00:00.000Z')

const build = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>) => {
  const requireReady = jest.fn(() => client)
  return {
    service: new ChatsService({ requireReady } as unknown as SessionManager),
    requireReady
  }
}
const ok = (value: unknown = true) => jest.fn(() => Promise.resolve(value))

describe('ChatsService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  describe('reads', () => {
    it('lists the chats and reads one, whatever its kind', async () => {
      const group = { id: 'g@g.us', participants: [] } as unknown as GroupChatDto
      const { service } = build({ getChats: ok([group]), getChatById: ok(group) })

      await expect(service.list('s')).resolves.toEqual([group])
      await expect(service.get('s', 'g@g.us')).resolves.toBe(group)
    })

    it('passes the limit and fromMe to the history, and reads the pinned messages', async () => {
      const fetchMessages = ok([])
      const getPinnedMessages = ok([])
      const { service } = build({ fetchMessages, getPinnedMessages, getChatById: ok({}) })

      await service.messages('s', CHAT, { limit: 20, fromMe: true })
      await service.messages('s', CHAT, { limit: 50 })
      await service.pinned('s', CHAT)

      expect(fetchMessages.mock.calls).toEqual([
        [CHAT, { limit: 20, fromMe: true }],
        [CHAT, { limit: 50 }]
      ])
      expect(getPinnedMessages).toHaveBeenCalledWith(CHAT)
    })

    it('needs a session that is ready', async () => {
      const requireReady = jest.fn(() => {
        throw new Error('not ready')
      })
      const service = new ChatsService({ requireReady } as unknown as SessionManager)

      await expect(service.list('s')).rejects.toThrow('not ready')
    })
  })

  describe('setState', () => {
    it('sends the state and, with a duration, clears it when the duration ends', async () => {
      const sendChatState = ok(undefined)
      const { service } = build({ sendChatState })

      await service.setState('s', CHAT, 'typing', 5000)
      expect(sendChatState.mock.calls).toEqual([[CHAT, 'typing']])

      await jest.advanceTimersByTimeAsync(4999)
      expect(sendChatState).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(sendChatState.mock.calls).toEqual([
        [CHAT, 'typing'],
        [CHAT, 'clear']
      ])
    })

    it('leaves the state to lapse by itself when there is no duration', async () => {
      const sendChatState = ok(undefined)
      const { service } = build({ sendChatState })

      await service.setState('s', CHAT, 'recording')
      await jest.advanceTimersByTimeAsync(60_000)

      expect(sendChatState.mock.calls).toEqual([[CHAT, 'recording']])
    })

    it('restarts the countdown when the same chat gets a new state, and stops it on clear', async () => {
      const sendChatState = ok(undefined)
      const { service } = build({ sendChatState })

      await service.setState('s', CHAT, 'typing', 5000)
      await jest.advanceTimersByTimeAsync(3000)
      await service.setState('s', CHAT, 'recording', 5000)
      await jest.advanceTimersByTimeAsync(3000)
      // The first countdown would have fired by now
      expect(sendChatState).toHaveBeenCalledTimes(2)
      await service.setState('s', CHAT, 'clear')
      await jest.advanceTimersByTimeAsync(10_000)

      expect(sendChatState.mock.calls).toEqual([
        [CHAT, 'typing'],
        [CHAT, 'recording'],
        [CHAT, 'clear']
      ])
    })

    it('counts down each chat of each session on its own', async () => {
      const sendChatState = jest.fn((_chat: string, _state: string) => Promise.resolve())
      const { service } = build({ sendChatState })

      await service.setState('s1', CHAT, 'typing', 1000)
      await service.setState('s2', CHAT, 'typing', 1000)
      await service.setState('s1', 'other@c.us', 'typing', 1000)
      await jest.advanceTimersByTimeAsync(1000)

      expect(sendChatState.mock.calls.filter(([, state]) => state === 'clear')).toHaveLength(3)
    })

    it('does not start a countdown for a state WhatsApp refused', async () => {
      const sendChatState = jest.fn(() => Promise.reject(new WaOperationError('sendChatState')))
      const { service } = build({ sendChatState })

      await expect(service.setState('s', CHAT, 'typing', 1000)).rejects.toBeInstanceOf(
        WaOperationError
      )
      await jest.advanceTimersByTimeAsync(5000)

      expect(sendChatState).toHaveBeenCalledTimes(1)
    })

    it('keeps one countdown when two states for the same chat overlap', async () => {
      const release: (() => void)[] = []
      const sendChatState = jest.fn(
        (_chat: string, state: string) =>
          new Promise<void>(resolve => {
            if (state === 'clear') resolve()
            else release.push(resolve)
          })
      )
      const { service } = build({ sendChatState })

      const first = service.setState('s', CHAT, 'typing', 20_000)
      const second = service.setState('s', CHAT, 'recording', 25_000)
      release.forEach(resolve => resolve())
      await Promise.all([first, second])
      await jest.advanceTimersByTimeAsync(20_000)
      // The recording lasts its 25 s: the countdown of the typing is gone
      expect(sendChatState.mock.calls.filter(([, state]) => state === 'clear')).toHaveLength(0)
      await jest.advanceTimersByTimeAsync(5000)

      expect(sendChatState.mock.calls.filter(([, state]) => state === 'clear')).toHaveLength(1)
    })

    it('keeps the countdown of the old state when the new one is refused', async () => {
      const sendChatState = jest
        .fn<Promise<void>, [string, string]>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new WaOperationError('sendChatState'))
        .mockResolvedValue(undefined)
      const { service } = build({ sendChatState })

      await service.setState('s', CHAT, 'typing', 5000)
      await expect(service.setState('s', CHAT, 'recording', 5000)).rejects.toBeInstanceOf(
        WaOperationError
      )
      await jest.advanceTimersByTimeAsync(5000)

      expect(sendChatState.mock.calls.map(([, state]) => state)).toEqual([
        'typing',
        'recording',
        'clear'
      ])
    })

    it('clears with the client the session has when the countdown ends, not the one it had', async () => {
      const old = { sendChatState: jest.fn(() => Promise.resolve()) }
      const current = { sendChatState: jest.fn(() => Promise.resolve()) }
      const requireReady = jest.fn().mockReturnValueOnce(old).mockReturnValue(current)
      const service = new ChatsService({ requireReady } as unknown as SessionManager)

      await service.setState('s', CHAT, 'typing', 1000)
      await jest.advanceTimersByTimeAsync(1000)

      expect(old.sendChatState.mock.calls).toEqual([[CHAT, 'typing']])
      expect(current.sendChatState.mock.calls).toEqual([[CHAT, 'clear']])
    })

    it('drops the clear quietly when the session is gone by the time the countdown ends', async () => {
      const client = { sendChatState: jest.fn(() => Promise.resolve()) }
      const requireReady = jest
        .fn()
        .mockReturnValueOnce(client)
        .mockImplementation(() => {
          throw new Error('not ready')
        })
      const service = new ChatsService({ requireReady } as unknown as SessionManager)

      await service.setState('s', CHAT, 'typing', 1000)
      await jest.advanceTimersByTimeAsync(1000)

      expect(client.sendChatState).toHaveBeenCalledTimes(1)
    })

    it('survives a clear that fails when the countdown ends, and drops the countdowns on shutdown', async () => {
      const sendChatState = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new WaOperationError('sendChatState'))
        .mockResolvedValue(undefined)
      const { service } = build({ sendChatState })

      await service.setState('s', CHAT, 'typing', 1000)
      await jest.advanceTimersByTimeAsync(1000)
      await service.setState('s', CHAT, 'typing', 1000)
      service.onModuleDestroy()
      await jest.advanceTimersByTimeAsync(5000)

      expect(sendChatState).toHaveBeenCalledTimes(3)
    })
  })

  describe('actions', () => {
    it.each([
      ['seen', 'sendSeen'],
      ['archive', 'archiveChat'],
      ['unarchive', 'unarchiveChat'],
      ['pin', 'pinChat'],
      ['unpin', 'unpinChat'],
      ['clearMessages', 'clearChatMessages'],
      ['delete', 'deleteChat'],
      ['syncHistory', 'syncHistory']
    ] as const)('%s calls %s and fails when WhatsApp says it did not', async (method, call) => {
      const fn = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const { service } = build({ [call]: fn, getChatById: ok({}) })

      await expect(service[method]('s', CHAT)).resolves.toBeUndefined()
      await expect(service[method]('s', CHAT)).rejects.toMatchObject({ code: 'WHATSAPP_ERROR' })
      expect(fn).toHaveBeenCalledWith(CHAT)
    })

    it.each([
      ['messages', (service: ChatsService) => service.messages('s', CHAT, { limit: 5 })],
      ['pinned', (service: ChatsService) => service.pinned('s', CHAT)],
      ['markUnread', (service: ChatsService) => service.markUnread('s', CHAT)],
      ['seen', (service: ChatsService) => service.seen('s', CHAT)],
      ['archive', (service: ChatsService) => service.archive('s', CHAT)],
      ['unarchive', (service: ChatsService) => service.unarchive('s', CHAT)],
      ['pin', (service: ChatsService) => service.pin('s', CHAT)],
      ['unpin', (service: ChatsService) => service.unpin('s', CHAT)],
      ['clearMessages', (service: ChatsService) => service.clearMessages('s', CHAT)],
      ['delete', (service: ChatsService) => service.delete('s', CHAT)],
      ['syncHistory', (service: ChatsService) => service.syncHistory('s', CHAT)],
      ['mute', (service: ChatsService) => service.mute('s', CHAT)],
      ['unmute', (service: ChatsService) => service.unmute('s', CHAT)]
    ])(
      '%s answers 404 for a chat the page does not have, and does not touch it',
      async (_n, run) => {
        const acted = jest.fn()
        const everyCall = [
          'fetchMessages',
          'getPinnedMessages',
          'markChatUnread',
          'sendSeen',
          'archiveChat',
          'unarchiveChat',
          'pinChat',
          'unpinChat',
          'clearChatMessages',
          'deleteChat',
          'syncHistory',
          'muteChat',
          'unmuteChat'
        ] as const
        const { service } = build({
          getChatById: jest.fn(() => Promise.reject(new WaChatNotFoundError('getChatById'))),
          ...Object.fromEntries(everyCall.map(name => [name, acted]))
        })

        await expect(run(service)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' })
        expect(acted).not.toHaveBeenCalled()
      }
    )

    it('marks a chat unread', async () => {
      const markChatUnread = ok(undefined)
      const { service } = build({ markChatUnread, getChatById: ok({}) })

      await service.markUnread('s', CHAT)

      expect(markChatUnread).toHaveBeenCalledWith(CHAT)
    })
  })

  describe('mute', () => {
    it('mutes until a date, and for ever without one', async () => {
      const muteChat = ok({ isMuted: true, muteExpiration: -1 })
      const { service } = build({ muteChat, getChatById: ok({}) })

      await service.mute('s', CHAT, '2026-01-02T00:00:00.000Z')
      await service.mute('s', CHAT)

      expect(muteChat.mock.calls).toEqual([[CHAT, new Date('2026-01-02T00:00:00.000Z')], [CHAT]])
    })

    it('refuses an end that is not in the future, without calling WhatsApp', async () => {
      const muteChat = ok()
      const { service } = build({ muteChat, getChatById: ok({}) })

      await expect(service.mute('s', CHAT, NOW.toISOString())).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
      await expect(service.mute('s', CHAT, '2025-12-31T00:00:00.000Z')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
      expect(muteChat).not.toHaveBeenCalled()
    })

    it('unmutes', async () => {
      const unmuteChat = ok({ isMuted: false, muteExpiration: 0 })
      const { service } = build({ unmuteChat, getChatById: ok({}) })

      await expect(service.unmute('s', CHAT)).resolves.toEqual({
        isMuted: false,
        muteExpiration: 0
      })
    })
  })
})
