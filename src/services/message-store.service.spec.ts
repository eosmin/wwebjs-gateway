import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import { ValidationError } from '../common/errors.js'
import { parseEnv } from '../config/env.schema.js'
import type { StoredMessage } from '../database/models.js'
import type {
  MessagesRepository,
  StoredMessageQuery
} from '../database/repositories/messages.repository.js'

import { MessageStoreService } from './message-store.service.js'

const row = (id: string, sentAt: string, dto: unknown = buildMessageDto({ id })): StoredMessage =>
  ({ id, sentAt: new Date(sentAt), dto }) as unknown as StoredMessage // reason: only the id, sentAt and dto are read

const encode = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

const decode = (cursor: string | null): unknown =>
  JSON.parse(Buffer.from(cursor ?? '', 'base64url').toString('utf8'))

describe('MessageStoreService', () => {
  const listStored = jest.fn<Promise<StoredMessage[]>, [StoredMessageQuery]>()
  const deleteOlderThan = jest.fn<Promise<number>, [Date]>()
  const warn = jest.spyOn(Logger.prototype, 'warn')
  const build = (env: Record<string, string> = {}): MessageStoreService =>
    new MessageStoreService(parseEnv({ ...TEST_ENV, ...env }), {
      listStored,
      deleteOlderThan
    } as unknown as MessagesRepository) // reason: only listStored and deleteOlderThan are called
  const lastQuery = (): StoredMessageQuery => {
    const query = listStored.mock.calls.at(-1)?.[0]
    if (!query) throw new Error('listStored was not called')
    return query
  }

  beforeEach(() => {
    jest.resetAllMocks()
    warn.mockImplementation(() => undefined)
  })

  describe('list', () => {
    it('asks for one row more than the limit and says there is no next page when it does not come', async () => {
      listStored.mockResolvedValue([
        row('b', '2026-10-27T12:00:02.000Z'),
        row('a', '2026-10-27T12:00:01.000Z')
      ])

      const page = await build().list({ sessionId: 's1', limit: 2 })

      expect(lastQuery()).toStrictEqual({ sessionId: 's1', limit: 3 })
      expect(page.items.map(item => item.id)).toEqual(['b', 'a'])
      expect(page.nextCursor).toBeNull()
    })

    it('answers an empty page with no cursor', async () => {
      listStored.mockResolvedValue([])

      expect(await build().list({ sessionId: 's1', limit: 5 })).toEqual({
        items: [],
        nextCursor: null
      })
    })

    it('hands out a cursor with a page of one when another row exists', async () => {
      listStored.mockResolvedValue([
        row('b', '2026-10-27T12:00:02.000Z'),
        row('a', '2026-10-27T12:00:01.000Z')
      ])

      const page = await build().list({ sessionId: 's1', limit: 1 })

      expect(page.items.map(item => item.id)).toEqual(['b'])
      expect(decode(page.nextCursor)).toEqual({ sentAt: '2026-10-27T12:00:02.000Z', id: 'b' })
    })

    it('continues from the cursor of the last row, keeping the milliseconds', async () => {
      listStored.mockResolvedValueOnce([
        row('c', '2026-10-27T12:00:03.000Z'),
        row('b', '2026-10-27T12:00:02.123Z'),
        row('a', '2026-10-27T12:00:01.000Z')
      ])
      const service = build()

      const first = await service.list({ sessionId: 's1', chatId: 'x@c.us', limit: 2 })
      listStored.mockResolvedValueOnce([])
      await service.list({
        sessionId: 's1',
        chatId: 'x@c.us',
        limit: 2,
        cursor: first.nextCursor ?? ''
      })

      expect(first.items.map(item => item.id)).toEqual(['c', 'b'])
      expect(lastQuery()).toStrictEqual({
        sessionId: 's1',
        chatId: 'x@c.us',
        before: { sentAt: new Date('2026-10-27T12:00:02.123Z'), id: 'b' },
        limit: 3
      })
    })

    it('leaves out a row that is not a message anymore, says so, and keeps no body in the log', async () => {
      listStored.mockResolvedValue([
        row('c', '2026-10-27T12:00:03.000Z'),
        row('b', '2026-10-27T12:00:02.000Z', { body: 'secret text' }),
        row('a', '2026-10-27T12:00:01.000Z')
      ])

      const page = await build().list({ sessionId: 's1', limit: 2 })

      expect(page.items.map(item => item.id)).toEqual(['c'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('b')
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret text')
    })

    it('takes the cursor from the last row read, not from the last readable one', async () => {
      listStored.mockResolvedValue([
        row('ok', '2026-10-27T12:00:03.000Z'),
        row('bad', '2026-10-27T12:00:02.000Z', {}),
        row('next', '2026-10-27T12:00:01.000Z')
      ])

      const page = await build().list({ sessionId: 's1', limit: 2 })

      expect(decode(page.nextCursor)).toEqual({ sentAt: '2026-10-27T12:00:02.000Z', id: 'bad' })
    })

    it('answers an empty page with a cursor when every row of it is unreadable', async () => {
      listStored.mockResolvedValue([
        row('bad', '2026-10-27T12:00:03.000Z', {}),
        row('next', '2026-10-27T12:00:02.000Z')
      ])

      const page = await build().list({ sessionId: 's1', limit: 1 })

      expect(page.items).toEqual([])
      expect(page.nextCursor).not.toBeNull()
    })

    it.each([
      ['not base64 json', 'not base64 json'],
      ['a date that does not exist', encode({ sentAt: '2026-02-31T00:00:00.000Z', id: 'a' })],
      ['a month out of range', encode({ sentAt: '2026-13-01T00:00:00.000Z', id: 'a' })],
      ['a date that is not a date', encode({ sentAt: 'yesterday', id: 'a' })],
      ['no sentAt', encode({ id: 'a' })],
      ['an empty id', encode({ sentAt: '2026-10-27T12:00:00.000Z', id: '' })],
      ['an extra key', encode({ sentAt: '2026-10-27T12:00:00.000Z', id: 'a', x: 1 })],
      ['null', encode('null')],
      ['an array', encode('[]')]
    ])('refuses the cursor with %s', async (_name, cursor) => {
      await expect(build().list({ sessionId: 's1', limit: 2, cursor })).rejects.toBeInstanceOf(
        ValidationError
      )
      expect(listStored).not.toHaveBeenCalled()
    })

    it('lets a failure of the repository through', async () => {
      listStored.mockRejectedValue(new Error('database down'))

      await expect(build().list({ sessionId: 's1', limit: 2 })).rejects.toThrow('database down')
    })
  })

  describe('purgeExpired', () => {
    it('deletes what is older than the retention days and returns the count', async () => {
      deleteOlderThan.mockResolvedValue(4)

      const removed = await build({ MESSAGE_RETENTION_DAYS: '10' }).purgeExpired(
        new Date('2026-10-29T00:00:00.000Z')
      )

      expect(deleteOlderThan).toHaveBeenCalledWith(new Date('2026-10-19T00:00:00.000Z'))
      expect(removed).toBe(4)
    })

    it('keeps 30 days by default', async () => {
      deleteOlderThan.mockResolvedValue(0)

      await build().purgeExpired(new Date('2026-10-31T00:00:00.000Z'))

      expect(parseEnv(TEST_ENV).MESSAGE_RETENTION_DAYS).toBe(30)
      expect(deleteOlderThan).toHaveBeenCalledWith(new Date('2026-10-01T00:00:00.000Z'))
    })

    it('counts from now when no date is given', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-31T00:00:00.000Z') })
      deleteOlderThan.mockResolvedValue(0)

      try {
        await build().purgeExpired()
      } finally {
        jest.useRealTimers()
      }

      expect(deleteOlderThan).toHaveBeenCalledWith(new Date('2026-10-01T00:00:00.000Z'))
    })

    it('lets a failure of the repository through', async () => {
      deleteOlderThan.mockRejectedValue(new Error('database down'))

      await expect(build().purgeExpired()).rejects.toThrow('database down')
    })
  })
})
