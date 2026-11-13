import { BroadcastDto, CallDto, ChatDto, GroupChatDto, MessageDto, OrderDto } from '../types/dto.js'

import {
  mapBroadcast,
  mapCall,
  mapChat,
  mapGroupChat,
  mapMessage,
  mapOrder,
  type MessageMapOptions,
  type MessageSource
} from './mappers.js'

// What a real account can hand over incomplete: wwebjs copies `data.x` without a default, so these
// mappers must degrade a missing field instead of throwing (a throw is a 500 for the whole listing).

const OPTIONS: MessageMapOptions = {
  receivedAt: new Date('2026-10-27T15:04:06.500Z'),
  includeRaw: false,
  rawMaxFieldBytes: 8192
}

const id = (value: string) => ({ _serialized: value })
const sparse = <T>(value: Record<string, unknown>): T => value as unknown as T

const MESSAGE = {
  id: id('false_5215500000001@c.us_3EB0AAAA'),
  ack: 1,
  deviceType: 'android',
  body: 'hi',
  broadcast: false,
  from: '5215500000001@c.us',
  fromMe: false,
  hasMedia: false,
  hasQuotedMsg: false,
  hasReaction: false,
  mentionedIds: [],
  groupMentions: [],
  timestamp: 1_792_000_000,
  to: '5215500000002@c.us',
  type: 'chat'
}

describe('mapGroupChat with the metadata incomplete', () => {
  const group = {
    id: id('120363000000000001@g.us'),
    createdAt: new Date(1_792_000_000_000),
    participants: [{ id: id('1@c.us'), isAdmin: true }]
  }

  it.each([
    ['an invalid date (creation missing)', new Date(Number.NaN)],
    ['a NaN number', Number.NaN],
    ['an undefined', undefined]
  ])('leaves createdAt out for %s instead of throwing', (_label, createdAt) => {
    const dto = mapGroupChat(sparse({ ...group, createdAt }), OPTIONS)

    expect(dto).not.toHaveProperty('createdAt')
    expect(GroupChatDto.parse(dto)).toEqual(dto)
  })

  it('gives no participants when the metadata holds none', () => {
    const dto = mapGroupChat(sparse({ ...group, participants: undefined }), OPTIONS)

    expect(dto.participants).toEqual([])
    expect(GroupChatDto.parse(dto)).toEqual(dto)
  })

  it('keeps createdAt when it is valid', () => {
    expect(mapGroupChat(sparse(group), OPTIONS).createdAt).toBe('2026-10-14T17:46:40.000Z')
  })
})

describe('mapBroadcast with the statuses missing', () => {
  it('gives no messages and counts them when WhatsApp left them out', () => {
    const dto = mapBroadcast(sparse({ id: id('status@broadcast'), timestamp: 1 }), OPTIONS)

    expect(dto).toMatchObject({ msgs: [], totalCount: 0, unreadCount: 0 })
    expect(BroadcastDto.parse(dto)).toEqual(dto)
  })

  it('takes the total from the messages it holds when the count is missing', () => {
    const dto = mapBroadcast(
      sparse({ id: id('status@broadcast'), timestamp: 1, msgs: [MESSAGE, MESSAGE] }),
      OPTIONS
    )

    expect(dto.totalCount).toBe(2)
    expect(dto.unreadCount).toBe(0)
  })

  it('leaves out one message that cannot be mapped and says so', () => {
    const unreadable = jest.fn()
    const dto = mapBroadcast(
      sparse({
        id: id('status@broadcast'),
        timestamp: 1,
        totalCount: 2,
        unreadCount: 0,
        msgs: [{ ...MESSAGE, from: undefined }, MESSAGE]
      }),
      { ...OPTIONS, onUnreadableMessage: unreadable }
    )

    expect(dto.msgs).toHaveLength(1)
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('mapping failed'))
    expect(BroadcastDto.parse(dto)).toEqual(dto)
  })
})

describe('mapOrder without products', () => {
  it('gives an empty list (Order.js sets products only when WhatsApp sent them)', () => {
    const dto = mapOrder(sparse({ subtotal: '1', total: '1', currency: 'MXN', createdAt: 1 }))

    expect(dto.products).toEqual([])
    expect(OrderDto.parse(dto)).toEqual(dto)
  })
})

describe('mapCall without the flags', () => {
  it('reads a missing isVideo, isGroup or fromMe as false', () => {
    const dto = mapCall(sparse({ id: 'c1', timestamp: 1 }))

    expect(dto).toMatchObject({ isVideo: false, isGroup: false, fromMe: false })
    expect(CallDto.parse(dto)).toEqual(dto)
  })

  it('keeps a flag WhatsApp did send', () => {
    expect(mapCall(sparse({ id: 'c1', timestamp: 1, isVideo: true })).isVideo).toBe(true)
  })
})

describe('a fractional unix time', () => {
  it('is not a usable message time: the arrival dates the message', () => {
    const invalid = jest.fn()
    const dto = mapMessage(sparse<MessageSource>({ ...MESSAGE, timestamp: 1_792_000_000.5 }), {
      ...OPTIONS,
      onInvalidTimestamp: invalid
    })

    expect(dto.timestamp).toBeNull()
    expect(invalid).toHaveBeenCalledTimes(1)
  })

  it('is dropped from a chat instead of failing its schema', () => {
    const dto = mapChat(
      sparse({ id: id('a@c.us'), timestamp: 1_792_000_000.5, muteExpiration: Number.NaN }),
      OPTIONS
    )

    expect(dto.timestamp).toBeNull()
    expect(dto).not.toHaveProperty('muteExpiration')
    expect(ChatDto.parse(dto)).toEqual(dto)
  })
})

describe('mapMessage with fields of the wrong type or missing', () => {
  const dropped = jest.fn()
  const options = { ...OPTIONS, onDroppedField: dropped }
  beforeEach(() => dropped.mockClear())

  it('leaves out an optional field of another type and names it, never its value', () => {
    const dto = mapMessage(
      sparse<MessageSource>({ ...MESSAGE, duration: 12, title: { odd: 'secret value' } }),
      options
    )

    expect(dto).not.toHaveProperty('duration')
    expect(dto).not.toHaveProperty('title')
    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dropped.mock.calls.flat().sort()).toEqual(['duration', 'title'])
    expect(JSON.stringify(dropped.mock.calls)).not.toContain('secret')
  })

  it('gives a missing body, type and device type a stated default', () => {
    const dto = mapMessage(
      sparse<MessageSource>({
        ...MESSAGE,
        body: undefined,
        type: undefined,
        deviceType: undefined
      }),
      options
    )

    expect(dto).toMatchObject({ body: '', type: 'unknown', deviceType: 'unknown' })
    expect(MessageDto.parse(dto)).toEqual(dto)
  })

  it('reads a missing flag as false', () => {
    const dto = mapMessage(
      sparse<MessageSource>({ ...MESSAGE, hasMedia: undefined, hasQuotedMsg: null }),
      options
    )

    expect(dto).toMatchObject({ hasMedia: false, hasQuotedMsg: false })
  })

  it('refuses a message that names no chat: there is no safe default for where it belongs', () => {
    expect(() =>
      mapMessage(sparse<MessageSource>({ ...MESSAGE, from: undefined }), options)
    ).toThrow(/chat/)
    expect(() =>
      mapMessage(sparse<MessageSource>({ ...MESSAGE, fromMe: true, to: undefined }), options)
    ).toThrow(/chat/)
  })

  it('keeps the other side of the conversation empty when only it is missing', () => {
    const dto = mapMessage(sparse<MessageSource>({ ...MESSAGE, to: undefined }), options)

    expect(dto.chatId).toBe(MESSAGE.from)
    expect(dto.to).toBe('')
    expect(MessageDto.parse(dto)).toEqual(dto)
  })

  it('survives arrays that are missing or hold odd entries', () => {
    const dto = mapMessage(
      sparse<MessageSource>({
        ...MESSAGE,
        mentionedIds: undefined,
        groupMentions: [null, { groupSubject: 'g' }],
        vCards: ['BEGIN:VCARD', undefined],
        pollOptions: [null, 'A', { name: 'B' }, { id: 1 }]
      }),
      options
    )

    expect(dto.mentionedIds).toEqual([])
    expect(dto.groupMentions).toEqual([])
    expect(dto.vCards).toEqual(['BEGIN:VCARD'])
    expect(dto.pollOptions).toEqual(['A', 'B'])
    expect(MessageDto.parse(dto)).toEqual(dto)
  })
})
