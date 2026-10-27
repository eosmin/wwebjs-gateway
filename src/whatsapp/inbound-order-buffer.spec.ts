import { Logger } from '@nestjs/common'

import { buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import type { MessageDto, OriginDto } from '../types/dto.js'

import {
  InboundOrderBuffer,
  type OrderBufferOptions,
  type OrderBufferPorts,
  type ReleasedBatch
} from './inbound-order-buffer.js'

const OPTIONS: OrderBufferOptions = {
  lateThresholdS: 3,
  windowMs: 1500,
  maxHoldMs: 5000,
  maxMessages: 200
}

const CHAT = '5215500000001@c.us'
const OTHER_CHAT = '5215500000002@c.us'
const NOW = new Date('2026-10-27T12:00:00.000Z')

interface Built {
  buffer: InboundOrderBuffer<string>
  released: ReleasedBatch<string>[]
  followers: string[][]
  fetchChatOrder: jest.Mock<Promise<MessageDto[]>, [string, number]>
  release: jest.Mock<Promise<void>, [ReleasedBatch<string>]>
  releaseFollowers: jest.Mock<Promise<void>, [string, string[]]>
}

function build(options: Partial<OrderBufferOptions> = {}): Built {
  const released: ReleasedBatch<string>[] = []
  const followers: string[][] = []
  const fetchChatOrder = jest.fn<Promise<MessageDto[]>, [string, number]>(() => Promise.resolve([]))
  const release = jest.fn<Promise<void>, [ReleasedBatch<string>]>(batch => {
    released.push(batch)
    return Promise.resolve()
  })
  const releaseFollowers = jest.fn<Promise<void>, [string, string[]]>((_chatId, late) => {
    followers.push(late)
    return Promise.resolve()
  })
  const ports: OrderBufferPorts<string> = { fetchChatOrder, release, releaseFollowers }
  const buffer = new InboundOrderBuffer('support-line', { ...OPTIONS, ...options }, ports)
  return { buffer, released, followers, fetchChatOrder, release, releaseFollowers }
}

// A message the sender wrote `writtenAgoS` seconds before the gateway got it (now)
function incoming(
  id: string,
  writtenAgoS: number,
  overrides: Partial<MessageDto> = {}
): MessageDto {
  return buildMessageDto({
    id,
    chatId: CHAT,
    fromMe: false,
    sentAt: new Date(Date.now() - writtenAgoS * 1000).toISOString(),
    receivedAt: new Date().toISOString(),
    ...overrides
  })
}

const ids = (batch: ReleasedBatch<string> | undefined): string[] =>
  batch?.items.map(item => item.message.id) ?? []

// The next release records its batch and stays open until the returned function is called
function holdNextRelease(built: Built): () => void {
  let finish: () => void = () => undefined
  built.release.mockImplementationOnce(batch => {
    built.released.push(batch)
    return new Promise<void>(resolve => {
      finish = resolve
    })
  })
  return () => finish()
}

const advance = (ms: number): Promise<void> => jest.advanceTimersByTimeAsync(ms)

let errorLog: jest.SpyInstance
let otherLogs: jest.SpyInstance[]

// Everything the buffer wrote to the log, whatever the level
const allLogged = (): string =>
  [errorLog, ...otherLogs].flatMap(spy => (spy.mock.calls as unknown[][]).flat()).join(' ')

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation()
  otherLogs = (['warn', 'log', 'debug', 'verbose'] as const).map(level =>
    jest.spyOn(Logger.prototype, level).mockImplementation()
  )
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('InboundOrderBuffer', () => {
  describe('messages that need no hold', () => {
    it('lets a message that is not late through, with no timer left behind', () => {
      const { buffer } = build()

      expect(buffer.offer(incoming('a', 1))).toBe(false)
      expect(jest.getTimerCount()).toBe(0)
    })

    it('treats exactly the threshold as not late', () => {
      const { buffer } = build()

      expect(buffer.offer(incoming('a', 3))).toBe(false)
    })

    it('holds a message later than the threshold', () => {
      const { buffer } = build()

      expect(buffer.offer(incoming('a', 4))).toBe(true)
    })

    it('keeps chats apart: a buffer in one chat does not hold another', () => {
      const { buffer } = build()
      buffer.offer(incoming('a', 10))

      expect(buffer.offer(incoming('b', 0, { chatId: OTHER_CHAT }))).toBe(false)
    })
  })

  describe('flush', () => {
    it('sorts a burst by sentAt and flags what moved', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('third', 10))
      buffer.offer(incoming('first', 30))
      buffer.offer(incoming('second', 20))

      await advance(OPTIONS.windowMs)

      expect(released).toHaveLength(1)
      expect(ids(released[0])).toEqual(['first', 'second', 'third'])
      const flags = released[0]?.items.map(item => item.message.ordering?.reordered)
      expect(flags).toEqual([true, true, true])
    })

    it('marks a message that kept its place as not reordered', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('first', 30))
      buffer.offer(incoming('second', 20))

      await advance(OPTIONS.windowMs)

      const flags = released[0]?.items.map(item => item.message.ordering)
      expect(flags?.map(ordering => ordering?.reordered)).toEqual([false, false])
      expect(flags?.every(ordering => ordering?.held)).toBe(true)
    })

    it('reports how long each message waited', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10))
      await advance(500)
      buffer.offer(incoming('b', 9))

      await advance(OPTIONS.windowMs)

      const heldMs = released[0]?.items.map(item => item.message.ordering?.heldMs)
      expect(heldMs).toEqual([2000, 1500])
    })

    it('does not mutate the message it was given', async () => {
      const { buffer } = build()
      const message = incoming('a', 10)
      buffer.offer(message)

      await advance(OPTIONS.windowMs)

      expect(message.ordering).toBeUndefined()
    })

    it('restarts the debounce on every arrival', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10))
      await advance(1000)
      buffer.offer(incoming('b', 9))
      await advance(1000)

      expect(released).toHaveLength(0)

      await advance(500)

      expect(ids(released[0])).toEqual(['a', 'b'])
    })

    it('lets a real-time message join the open buffer to keep the order', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('old', 20))

      expect(buffer.offer(incoming('live', 0))).toBe(true)

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['old', 'live'])
    })

    it('force-flushes when the buffer has been open for the max hold', async () => {
      const { buffer, released } = build()
      // A new arrival every second keeps the debounce from ever firing
      for (let i = 0; i < 5; i += 1) {
        buffer.offer(incoming(`m${i}`, 30 - i))
        await advance(1000)
      }

      expect(released).toHaveLength(1)
      expect(ids(released[0])).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    })

    it('force-flushes at the max message count without waiting for a timer', async () => {
      const { buffer, released } = build({ maxMessages: 3 })
      buffer.offer(incoming('a', 10))
      buffer.offer(incoming('b', 9))
      buffer.offer(incoming('c', 8))

      await advance(0)

      expect(ids(released[0])).toEqual(['a', 'b', 'c'])
    })

    it('returns to zero added latency once the chat is flushed', async () => {
      const { buffer } = build()
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(buffer.offer(incoming('b', 0))).toBe(false)
      expect(jest.getTimerCount()).toBe(0)
    })

    it('ignores a message already held', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10))

      expect(buffer.offer(incoming('a', 10))).toBe(true)

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['a'])
    })
  })

  describe('ties inside the same second', () => {
    it('follows the order WhatsApp Web shows', async () => {
      const { buffer, released, fetchChatOrder } = build()
      const a = incoming('a', 10, { sentAt: '2026-10-27T11:59:50.000Z' })
      const b = incoming('b', 10, { sentAt: '2026-10-27T11:59:50.000Z' })
      fetchChatOrder.mockResolvedValue([b, a])
      buffer.offer(a)
      buffer.offer(b)

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['b', 'a'])
      expect(released[0]?.items.map(item => item.message.ordering?.reordered)).toEqual([true, true])
    })

    it('asks for the buffer size plus a margin, once per flush', async () => {
      const { buffer, fetchChatOrder } = build()
      buffer.offer(incoming('a', 10))
      buffer.offer(incoming('b', 9))

      await advance(OPTIONS.windowMs)

      expect(fetchChatOrder).toHaveBeenCalledTimes(1)
      expect(fetchChatOrder).toHaveBeenCalledWith(CHAT, 7)
    })

    it('never lets the canonical order beat sentAt', async () => {
      const { buffer, released, fetchChatOrder } = build()
      const late = incoming('late', 5)
      const early = incoming('early', 20)
      fetchChatOrder.mockResolvedValue([late, early])
      buffer.offer(late)
      buffer.offer(early)

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['early', 'late'])
    })

    it('puts a message WhatsApp Web does not list after the ones it does', async () => {
      const { buffer, released, fetchChatOrder } = build()
      const sentAt = '2026-10-27T11:59:50.000Z'
      const unlisted = incoming('unlisted', 10, { sentAt })
      const listed = incoming('listed', 10, { sentAt })
      fetchChatOrder.mockResolvedValue([listed])
      buffer.offer(unlisted)
      buffer.offer(listed)

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['listed', 'unlisted'])
    })

    it('falls back to receivedAt, then arrival, when the fetch fails', async () => {
      const { buffer, released, fetchChatOrder } = build()
      fetchChatOrder.mockRejectedValue(new Error('page crashed'))
      const sentAt = '2026-10-27T11:59:50.000Z'
      const first = incoming('first', 10, { sentAt, receivedAt: '2026-10-27T11:59:59.000Z' })
      const second = incoming('second', 10, { sentAt, receivedAt: '2026-10-27T11:59:59.500Z' })
      const third = incoming('third', 10, { sentAt, receivedAt: '2026-10-27T11:59:59.500Z' })
      buffer.offer(second)
      buffer.offer(third)
      buffer.offer(first)

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['first', 'second', 'third'])
      expect(errorLog).toHaveBeenCalledWith(
        'Order buffer chat order fetch failed (session support-line): Error'
      )
    })
  })

  describe('message_batch', () => {
    it('adds a batch of the messages, in order, when the contact wrote two or more', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('b', 10))
      buffer.offer(incoming('a', 20))

      await advance(OPTIONS.windowMs)

      const batch = released[0]?.batch
      expect(batch?.messages.map(message => message.id)).toEqual(['a', 'b'])
      expect(batch).toMatchObject({
        chatId: CHAT,
        count: 2,
        reason: 'burst',
        firstSentAt: new Date(NOW.getTime() - 20_000).toISOString(),
        lastSentAt: new Date(NOW.getTime() - 10_000).toISOString()
      })
      expect(batch).not.toHaveProperty('origin')
    })

    it('carries the ordering flags in the batch messages', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10))
      buffer.offer(incoming('b', 9))

      await advance(OPTIONS.windowMs)

      expect(released[0]?.batch?.messages.every(message => message.ordering?.held)).toBe(true)
    })

    it('has no batch for a single incoming message', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10))

      await advance(OPTIONS.windowMs)

      expect(released[0]?.batch).toBeUndefined()
    })

    it('makes no batch for two own messages and none from the contact', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10, { fromMe: true }))
      buffer.offer(incoming('b', 9, { fromMe: true }))

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['a', 'b'])
      expect(released[0]?.batch).toBeUndefined()
    })

    it('includes own messages in the batch, in order, when the contact wrote two or more', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 30))
      buffer.offer(incoming('mine', 20, { fromMe: true }))
      buffer.offer(incoming('b', 10))

      await advance(OPTIONS.windowMs)

      expect(released[0]?.batch?.messages.map(message => message.id)).toEqual(['a', 'mine', 'b'])
      expect(released[0]?.batch?.count).toBe(3)
    })

    it('makes no batch for one contact message and one of ours', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 30))
      buffer.offer(incoming('mine', 20, { fromMe: true }))

      await advance(OPTIONS.windowMs)

      expect(released[0]?.batch).toBeUndefined()
    })

    it('takes the first origin found among the messages', async () => {
      const origin = (title: string): OriginDto => ({ kind: 'click_to_whatsapp_ad', title })
      const { buffer, released } = build()
      buffer.offer(incoming('c', 5, { origin: origin('later ad') }))
      buffer.offer(incoming('b', 10))
      buffer.offer(incoming('a', 20, { origin: origin('first ad') }))

      await advance(OPTIONS.windowMs)

      expect(released[0]?.batch?.origin).toEqual(origin('first ad'))
    })

    it('says reconcile when any message came from the reconciler', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10), 'reconcile')
      buffer.offer(incoming('b', 9))

      await advance(OPTIONS.windowMs)

      expect(released[0]?.batch?.reason).toBe('reconcile')
    })
  })

  describe('followers of a held message', () => {
    it('refuses followers of a message that is not held', () => {
      const { buffer } = build()

      expect(buffer.holdBehind('unknown', 'ack')).toBe(false)
    })

    it('releases the followers right behind their message', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('b', 10))
      buffer.offer(incoming('a', 20))

      expect(buffer.holdBehind('b', 'ack-b-1')).toBe(true)
      expect(buffer.holdBehind('a', 'edit-a')).toBe(true)
      expect(buffer.holdBehind('b', 'ack-b-2')).toBe(true)

      await advance(OPTIONS.windowMs)

      expect(released[0]?.items.map(item => item.followers)).toEqual([
        ['edit-a'],
        ['ack-b-1', 'ack-b-2']
      ])
    })

    it('stops holding once the message was released', async () => {
      const { buffer } = build()
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(buffer.holdBehind('a', 'ack')).toBe(false)
    })

    it('does not restart the debounce', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10))
      await advance(1000)
      buffer.holdBehind('a', 'ack')
      await advance(500)

      expect(released).toHaveLength(1)
    })

    it('releases a follower that arrives while the batch is being released', async () => {
      const { buffer, release, followers } = build()
      let finish: () => void = () => undefined
      release.mockImplementationOnce(() => {
        // The follower shows up after the snapshot, while the pipeline is still stamping seq
        buffer.holdBehind('a', 'late-ack')
        return new Promise<void>(resolve => {
          finish = resolve
        })
      })
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(followers).toHaveLength(0)

      finish()
      await advance(0)

      expect(followers).toEqual([['late-ack']])
      expect(buffer.holdBehind('a', 'too-late')).toBe(false)
    })
  })

  describe('order across flushes', () => {
    it('queues a message that arrives while a flush is in flight behind it', async () => {
      const { buffer, release, released } = build()
      let finish: () => void = () => undefined
      release.mockImplementationOnce(batch => {
        released.push(batch)
        return new Promise<void>(resolve => {
          finish = resolve
        })
      })
      buffer.offer(incoming('old', 20))
      await advance(OPTIONS.windowMs)

      // The first batch is not out yet: this one must not overtake it
      expect(buffer.offer(incoming('new', 0))).toBe(true)
      await advance(OPTIONS.windowMs)

      expect(released).toHaveLength(1)

      finish()
      await advance(0)

      expect(released.map(ids)).toEqual([['old'], ['new']])
    })

    it('keeps flushing after a release failed', async () => {
      const { buffer, release, released } = build()
      release.mockRejectedValueOnce(new Error('redis down'))
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(errorLog).toHaveBeenCalledWith(
        'Order buffer release failed (session support-line): Error'
      )
      expect(buffer.holdBehind('a', 'ack')).toBe(false)

      buffer.offer(incoming('b', 10))
      await advance(OPTIONS.windowMs)

      expect(released.map(ids)).toEqual([['b']])
    })

    it('logs a failed release, publishes no follower of that batch and keeps working', async () => {
      const { buffer, release, releaseFollowers, released } = build()
      release.mockRejectedValueOnce(new Error('redis down'))
      buffer.offer(incoming('a', 10))
      buffer.holdBehind('a', 'ack')
      await advance(OPTIONS.windowMs)

      expect(releaseFollowers).not.toHaveBeenCalled()
      expect(buffer.holdBehind('a', 'late-ack')).toBe(false)

      buffer.offer(incoming('b', 10))
      await advance(OPTIONS.windowMs)

      expect(released.map(ids)).toEqual([['b']])
    })

    it('logs a failed follower release and keeps working', async () => {
      const { buffer, release, releaseFollowers, released } = build()
      release.mockImplementationOnce(batch => {
        released.push(batch)
        buffer.holdBehind('a', 'late-ack')
        return Promise.resolve()
      })
      releaseFollowers.mockRejectedValueOnce(new Error('redis down'))
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(errorLog).toHaveBeenCalledWith(
        'Order buffer follower release failed (session support-line): Error'
      )

      buffer.offer(incoming('b', 10))
      await advance(OPTIONS.windowMs)

      expect(released.map(ids)).toEqual([['a'], ['b']])
    })

    it('still delivers the followers that arrive after a failed follower release', async () => {
      const { buffer, release, releaseFollowers, released, followers } = build()
      release.mockImplementationOnce(batch => {
        released.push(batch)
        buffer.holdBehind('a', 'f1')
        return Promise.resolve()
      })
      releaseFollowers.mockImplementationOnce(() => {
        buffer.holdBehind('a', 'f2')
        return Promise.reject(new Error('redis down'))
      })
      buffer.offer(incoming('a', 10))

      await advance(OPTIONS.windowMs)

      expect(followers).toEqual([['f2']])
    })

    it('never logs message content', async () => {
      const { buffer, release } = build()
      release.mockRejectedValueOnce(new Error('could not store: hola, mi tarjeta es 4111'))
      buffer.offer(incoming('a', 10))

      await advance(OPTIONS.windowMs)

      const logged = allLogged()
      expect(logged).not.toContain('4111')
    })
  })

  describe('close', () => {
    it('drops what is held without releasing it', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 10))

      buffer.close()
      await advance(OPTIONS.maxHoldMs)

      expect(released).toHaveLength(0)
      expect(jest.getTimerCount()).toBe(0)
      expect(buffer.holdBehind('a', 'ack')).toBe(false)
    })

    it('drops a flush that was waiting for the chat order', async () => {
      const { buffer, released, fetchChatOrder } = build()
      let answer: (messages: MessageDto[]) => void = () => undefined
      fetchChatOrder.mockImplementation(
        () =>
          new Promise<MessageDto[]>(resolve => {
            answer = resolve
          })
      )
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(fetchChatOrder).toHaveBeenCalledTimes(1)
      buffer.close()
      answer([])
      await advance(0)

      expect(released).toHaveLength(0)
    })

    it('lets everything through afterwards', () => {
      const { buffer } = build()
      buffer.close()

      expect(buffer.offer(incoming('a', 60))).toBe(false)
    })
  })

  describe('follower delivery and ordering edge cases', () => {
    it('delivers a follower held before the flush once, inline, and one added during release once', async () => {
      const { buffer, release, released, followers } = build()
      release.mockImplementationOnce(batch => {
        released.push(batch)
        buffer.holdBehind('a', 'f2')
        return Promise.resolve()
      })
      buffer.offer(incoming('a', 10))
      buffer.holdBehind('a', 'f1')

      await advance(OPTIONS.windowMs)

      expect(released[0]?.items[0]?.followers).toEqual(['f1'])
      expect(followers).toEqual([['f2']])
    })

    it('keeps releasing followers that arrive while earlier late followers are released', async () => {
      const { buffer, release, releaseFollowers, released, followers } = build()
      release.mockImplementationOnce(batch => {
        released.push(batch)
        buffer.holdBehind('a', 'f2')
        return Promise.resolve()
      })
      releaseFollowers.mockImplementationOnce((_chatId, late) => {
        followers.push(late)
        buffer.holdBehind('a', 'f3')
        return Promise.resolve()
      })
      buffer.offer(incoming('a', 10))

      await advance(OPTIONS.windowMs)

      expect(followers).toEqual([['f2'], ['f3']])
    })

    it('does not lose a follower attached in the microtask after the last check', async () => {
      const { buffer, release, followers } = build()
      let finish: () => void = () => undefined
      const pending = new Promise<void>(resolve => {
        finish = resolve
      })
      release.mockImplementationOnce(() => pending)
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      // Runs between the end of the last check and the resumption of the flush
      let accepted = false
      void pending.then(() => {
        accepted = buffer.holdBehind('a', 'gap-ack')
      })
      finish()
      await advance(0)

      // The message is gone by then: the caller publishes the ack itself, nothing is queued and lost
      expect(accepted).toBe(false)
      expect(followers).toHaveLength(0)
    })

    it('puts a follower of a message in a queued second buffer inside that buffer', async () => {
      const built = build()
      const finish = holdNextRelease(built)
      built.buffer.offer(incoming('old', 20))
      await advance(OPTIONS.windowMs)
      built.buffer.offer(incoming('new', 0))

      expect(built.buffer.holdBehind('new', 'ack')).toBe(true)

      finish()
      await advance(OPTIONS.windowMs)

      expect(built.released[1]?.items[0]?.followers).toEqual(['ack'])
      expect(built.followers).toHaveLength(0)
    })

    it('puts a follower that arrives while the chat order is fetched inside the batch', async () => {
      const { buffer, released, followers, fetchChatOrder } = build()
      let answer: (messages: MessageDto[]) => void = () => undefined
      fetchChatOrder.mockImplementation(
        () =>
          new Promise<MessageDto[]>(resolve => {
            answer = resolve
          })
      )
      buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(buffer.holdBehind('a', 'ack')).toBe(true)

      answer([])
      await advance(0)

      expect(released[0]?.items[0]?.followers).toEqual(['ack'])
      expect(followers).toHaveLength(0)
    })

    it('ranks the WhatsApp Web order above receivedAt', async () => {
      const { buffer, released, fetchChatOrder } = build()
      const sentAt = '2026-10-27T11:59:50.000Z'
      const a = incoming('a', 10, { sentAt, receivedAt: '2026-10-27T11:59:58.000Z' })
      const b = incoming('b', 10, { sentAt, receivedAt: '2026-10-27T11:59:59.000Z' })
      fetchChatOrder.mockResolvedValue([b, a])
      buffer.offer(a)
      buffer.offer(b)

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['b', 'a'])
    })

    it('flags only the messages that moved', async () => {
      const { buffer, released } = build()
      buffer.offer(incoming('a', 30))
      buffer.offer(incoming('c', 10))
      buffer.offer(incoming('b', 20))

      await advance(OPTIONS.windowMs)

      expect(ids(released[0])).toEqual(['a', 'b', 'c'])
      expect(released[0]?.items.map(item => item.message.ordering?.reordered)).toEqual([
        false,
        true,
        true
      ])
    })

    it('does not log the content of a failed chat order fetch', async () => {
      const { buffer, fetchChatOrder } = build()
      fetchChatOrder.mockRejectedValue(new Error('hola 4111'))
      buffer.offer(incoming('a', 10))

      await advance(OPTIONS.windowMs)

      expect(errorLog).toHaveBeenCalledTimes(1)
      expect(allLogged()).not.toContain('4111')
    })

    it('treats a sentAt in the future or an unreadable one as not late', () => {
      const { buffer } = build()

      expect(buffer.offer(incoming('future', -10))).toBe(false)
      expect(buffer.offer(incoming('garbage', 0, { sentAt: 'not a date' }))).toBe(false)
    })

    it('flushes on the first message when the maximum is one', async () => {
      const { buffer, released } = build({ maxMessages: 1 })

      expect(buffer.offer(incoming('a', 10))).toBe(true)
      await advance(0)

      expect(ids(released[0])).toEqual(['a'])
    })

    it('opens a second buffer for what comes after a size flush, released in order', async () => {
      const { buffer, released } = build({ maxMessages: 2 })
      buffer.offer(incoming('a', 20))
      buffer.offer(incoming('b', 19))

      expect(buffer.offer(incoming('c', 0))).toBe(true)

      await advance(OPTIONS.windowMs)

      expect(released.map(ids)).toEqual([['a', 'b'], ['c']])
    })

    it('flushes right after the arrival when the window is zero', async () => {
      const { buffer, released } = build({ windowMs: 0 })
      buffer.offer(incoming('a', 10))

      await advance(0)

      expect(ids(released[0])).toEqual(['a'])
    })

    it('flushes each chat on its own, without waiting for another chat', async () => {
      const built = build()
      holdNextRelease(built)
      built.buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      built.buffer.offer(incoming('x', 10, { chatId: OTHER_CHAT }))
      await advance(OPTIONS.windowMs)

      expect(built.released.map(batch => batch.chatId)).toEqual([CHAT, OTHER_CHAT])
      expect(ids(built.released[1])).toEqual(['x'])
    })

    it('keeps a message that is re-offered while its batch is being released out of a second batch', async () => {
      const built = build()
      const finish = holdNextRelease(built)
      built.buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)

      expect(built.buffer.offer(incoming('a', 10))).toBe(true)

      finish()
      await advance(OPTIONS.windowMs)

      expect(built.released.map(ids)).toEqual([['a']])
    })

    it('sends no follower after close, even one that attached during the release', async () => {
      const built = build()
      const finish = holdNextRelease(built)
      built.buffer.offer(incoming('a', 10))
      await advance(OPTIONS.windowMs)
      built.buffer.holdBehind('a', 'late-ack')

      built.buffer.close()
      finish()
      await advance(0)

      expect(built.releaseFollowers).not.toHaveBeenCalled()
    })

    it('never releases or fetches a queued second buffer after close', async () => {
      const built = build()
      const finish = holdNextRelease(built)
      built.buffer.offer(incoming('old', 20))
      await advance(OPTIONS.windowMs)
      built.buffer.offer(incoming('new', 0))
      await advance(OPTIONS.windowMs)

      built.buffer.close()
      finish()
      await advance(OPTIONS.windowMs)

      expect(built.released.map(ids)).toEqual([['old']])
      expect(built.fetchChatOrder).toHaveBeenCalledTimes(1)
    })
  })
})
