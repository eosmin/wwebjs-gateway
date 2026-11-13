import type { z } from 'zod'

import {
  BroadcastDto,
  BusinessContactDto,
  CallDto,
  ChannelDto,
  ChatDto,
  ClientInfoDto,
  ContactDto,
  GroupChatDto,
  GroupNotificationDto,
  LabelDto,
  MembershipRequestDto,
  MessageDto,
  OrderDto,
  PaymentDto,
  ReactionDto,
  ReactionListDto
} from '../types/dto.js'

import {
  failedFields,
  mapBroadcast,
  mapBusinessContact,
  mapCall,
  mapChannel,
  mapChat,
  mapClientInfo,
  mapContact,
  mapGroupChat,
  mapGroupNotification,
  mapLabel,
  mapMembershipRequest,
  mapMessage,
  mapOrder,
  mapPayment,
  mapReaction,
  mapReactionList,
  type MessageMapOptions,
  type MessageSource
} from './mappers.js'

// Contract of the mappers with what WhatsApp Web really hands over. wwebjs copies `this.x = data.x`
// without a default, so a field a real account lacks arrives `undefined`: the DTO of the response
// must still pass its schema (a response that fails it is a 500, also for a send that went out).
// The payloads are redacted: ids are made up, there are no numbers or texts of real people.

const OPTIONS: MessageMapOptions = {
  receivedAt: new Date('2026-10-27T15:04:06.500Z'),
  includeRaw: false,
  rawMaxFieldBytes: 8192
}

const id = (value: string) => ({ _serialized: value })
const sparse = <T>(value: Record<string, unknown>): T => value as unknown as T

// A complete payload minus the fields the real account did not have
function without<T extends Record<string, unknown>>(base: T, ...missing: string[]): T {
  const copy: Record<string, unknown> = { ...base }
  for (const key of missing) delete copy[key]
  return copy as T
}

const MESSAGE = {
  id: id('true_100000000000001@lid_3EB0AAAA'),
  ack: 1,
  deviceType: 'android',
  body: '',
  broadcast: false,
  isStatus: false,
  isGif: false,
  isEphemeral: false,
  from: 'a@c.us',
  fromMe: true,
  hasMedia: false,
  hasQuotedMsg: false,
  hasReaction: false,
  isForwarded: false,
  forwardingScore: 0,
  isStarred: false,
  vCards: [],
  mentionedIds: [],
  groupMentions: [],
  timestamp: 1_792_000_000,
  to: '100000000000001@lid',
  type: 'location',
  links: []
}

const CONTACT = {
  id: id('100000000000001@lid'),
  number: '100000000000001',
  isBusiness: false,
  isEnterprise: false,
  isGroup: false,
  isMe: false,
  isMyContact: true,
  isUser: true,
  isWAContact: true,
  isBlocked: false,
  statusMute: false,
  pushname: 'Name',
  sectionHeader: 'A',
  type: 'in'
}

const CHAT = {
  id: id('100000000000001@lid'),
  isGroup: false,
  isMuted: false,
  muteExpiration: 0,
  name: 'Name',
  unreadCount: 0,
  pinned: false
}

describe('location', () => {
  const location = (latitude: unknown, longitude: unknown) =>
    sparse<MessageSource>({ ...MESSAGE, location: { latitude, longitude, name: 'Plaza' } })

  it.each([
    [19.4, -99.1],
    ['19.4', '-99.1']
  ])('delivers numbers whether wwebjs hands %p and %p as numbers or as strings', (lat, lon) => {
    const dto = mapMessage(location(lat, lon), OPTIONS)

    expect(dto.location).toEqual({ latitude: 19.4, longitude: -99.1, name: 'Plaza' })
    expect(MessageDto.parse(dto)).toEqual(dto)
  })

  it.each([
    [undefined, 'x'],
    [null, 1],
    ['', 1],
    ['  ', 1],
    [1, Number.NaN]
  ])(
    'keeps the message and leaves out a location with coordinates %p and %p (not a 0,0 point)',
    (lat, lon) => {
      const dto = mapMessage(location(lat, lon), OPTIONS)

      expect(dto.location).toBeUndefined()
      expect(MessageDto.parse(dto)).toEqual(dto)
    }
  )
})

describe('an invite that lacks a field', () => {
  it('is left out of the message, which is kept', () => {
    const dto = mapMessage(
      sparse<MessageSource>({
        ...MESSAGE,
        type: 'groups_v4_invite',
        inviteV4: { inviteCode: 'abc', groupId: 'g@g.us' }
      }),
      OPTIONS
    )

    expect(dto.inviteV4).toBeUndefined()
    expect(MessageDto.parse(dto)).toEqual(dto)
  })
})

describe('an invite as 1.34.8 delivers it (every key a string)', () => {
  const invite = (inviteCodeExp: unknown) =>
    mapMessage(
      sparse<MessageSource>({
        ...MESSAGE,
        type: 'groups_v4_invite',
        inviteV4: {
          toId: '100000000000001@lid',
          fromId: '100000000000002@lid',
          groupId: '120000000000000001@g.us',
          groupName: 'Group',
          inviteCode: 'abc',
          inviteCodeExp
        }
      }),
      OPTIONS
    )

  it.each([
    ['1792000000', 1_792_000_000],
    ['0', 0],
    [1_792_000_000, 1_792_000_000]
  ])('reads an expiration of %p as the number %p', (exp, expected) => {
    const dto = invite(exp)

    expect(dto.inviteV4?.inviteCodeExp).toBe(expected)
    expect(MessageDto.parse(dto)).toEqual(dto)
  })

  it.each(['', 'soon', '12x', Number.NaN, null])(
    'leaves the invite out when the expiration is %p, and keeps the message',
    exp => {
      const dto = invite(exp)

      expect(dto.inviteV4).toBeUndefined()
      expect(MessageDto.parse(dto)).toEqual(dto)
    }
  )
})

// The keys a response schema requires, read from the schema itself: a new required field of a DTO joins
// the loop below by itself, and no mapper can quietly stop filling one
function requiredKeys(schema: { shape: Record<string, z.ZodType> }): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key)
}

const GROUP = {
  ...CHAT,
  id: id('120000000000000001@g.us'),
  archived: false,
  isReadOnly: false,
  isLocked: false,
  timestamp: 1_792_000_000,
  owner: id('100000000000001@lid'),
  createdAt: 1_761_577_446,
  description: 'About',
  participants: [{ id: id('100000000000001@lid'), isAdmin: true, isSuperAdmin: false }]
}

const BROADCAST = {
  id: id('status@broadcast'),
  timestamp: 1_792_000_000,
  totalCount: 1,
  unreadCount: 0,
  msgs: [MESSAGE]
}

const CALL = { id: 'c1', timestamp: 1, isVideo: false, isGroup: false, fromMe: false }

// What a mapper may refuse instead of inventing: the id of anything, and where a message belongs
const REFUSED: Record<string, string[]> = { message: ['id', 'to'] }
const ALWAYS_REFUSED = ['id'] // nothing is told apart without its id

describe.each([
  [
    'message',
    MessageDto,
    MESSAGE,
    (source: unknown) =>
      mapMessage(sparse<MessageSource>(source as Record<string, unknown>), OPTIONS)
  ],
  [
    'contact',
    ContactDto,
    CONTACT,
    (source: unknown) => mapContact(sparse(source as Record<string, unknown>))
  ],
  [
    'chat',
    ChatDto,
    CHAT,
    (source: unknown) => mapChat(sparse(source as Record<string, unknown>), OPTIONS)
  ],
  [
    'group chat',
    GroupChatDto,
    GROUP,
    (source: unknown) => mapGroupChat(sparse(source as Record<string, unknown>), OPTIONS)
  ],
  [
    'broadcast',
    BroadcastDto,
    BROADCAST,
    (source: unknown) => mapBroadcast(sparse(source as Record<string, unknown>), OPTIONS)
  ],
  ['call', CallDto, CALL, (source: unknown) => mapCall(sparse(source as Record<string, unknown>))]
] as const)('every required field of the %s DTO', (name, schema, fixture, map) => {
  const refused = [...ALWAYS_REFUSED, ...(REFUSED[name] ?? [])]

  it('is a field the mapper fills or refuses on purpose, never one that fails the response', () => {
    const keys = requiredKeys(schema as never).filter(key => key in fixture)

    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const source = without(fixture as Record<string, unknown>, key)
      const mapped = ((): unknown => {
        try {
          return map(source)
        } catch (error: unknown) {
          if (refused.includes(key)) return 'refused'
          throw new Error(`${name} without ${key} made the mapper throw`, { cause: error })
        }
      })()
      if (mapped === 'refused') continue
      const parsed = (schema as z.ZodType).safeParse(mapped)
      if (!parsed.success) {
        throw new Error(
          `${name} without ${key} breaks its schema: ${failedFields(parsed.error).join(', ')}`
        )
      }
    }
  })
})

describe('a message of a special type that lacks what Message.js copies without a default', () => {
  it.each(['isStarred', 'links', 'vCards', 'isStatus', 'isGif', 'forwardingScore'])(
    'is delivered without %s, which is false, empty or 0',
    field => {
      const dto = mapMessage(sparse<MessageSource>(without(MESSAGE, field)), OPTIONS)

      expect(MessageDto.parse(dto)).toEqual(dto)
    }
  )
})

// The structured types of WhatsApp Web, with the least a real message of each carries (made up, no
// real data): none may throw, and each must still pass the schema of the response
describe.each<[string, Record<string, unknown>]>([
  ['vcard', { type: 'vcard', body: 'BEGIN:VCARD\nEND:VCARD', vCards: ['BEGIN:VCARD\nEND:VCARD'] }],
  ['multi_vcard', { type: 'multi_vcard', body: '', vCards: ['BEGIN:VCARD', 'BEGIN:VCARD'] }],
  ['ciphertext', { type: 'ciphertext', body: '' }],
  ['call_log', { type: 'call_log', body: '' }],
  ['reaction', { type: 'reaction', body: '👍', hasReaction: true }],
  ['product', { type: 'product', body: '', productId: 'p1', title: 'Item', description: 'd' }],
  ['order', { type: 'order', body: '', orderId: 'o1', title: 'Order' }],
  [
    'template',
    {
      type: 'template_button_reply',
      body: '',
      selectedButtonId: 'b1',
      dynamicReplyButtons: [{ buttonId: 'b1' }]
    }
  ],
  [
    'poll_creation',
    {
      type: 'poll_creation',
      body: '',
      pollName: 'Q',
      pollOptions: [{ name: 'A', localId: 0 }, 'B']
    }
  ],
  ['groups_v4_invite', { type: 'groups_v4_invite', body: '', inviteV4: undefined }]
])('a %s message', (_name, extra) => {
  it('is delivered with the least WhatsApp Web hands over', () => {
    const minimal = {
      id: MESSAGE.id,
      from: MESSAGE.from,
      to: MESSAGE.to,
      fromMe: false,
      timestamp: MESSAGE.timestamp,
      ...extra
    }
    const dto = mapMessage(sparse<MessageSource>(minimal), OPTIONS)

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto.type).toBe(extra['type'])
  })

  it('is delivered with its payload fields of another type, which are left out', () => {
    const odd = Object.fromEntries(
      Object.keys(extra)
        .filter(key => key !== 'type')
        .map(key => [key, { odd: 1 }])
    )
    const dto = mapMessage(
      sparse<MessageSource>({ ...MESSAGE, type: extra['type'], ...odd, body: 'x' }),
      OPTIONS
    )

    expect(MessageDto.parse(dto)).toEqual(dto)
  })
})

describe('a last message that does not fit its schema', () => {
  const broken = sparse<MessageSource>({ ...MESSAGE, forwardingScore: 'many' })

  it('is left out of the chat, which is kept, and its fields are reported without values', () => {
    const unreadable = jest.fn()

    const dto = mapChat(sparse({ ...CHAT, lastMessage: broken }), {
      ...OPTIONS,
      onUnreadableMessage: unreadable
    })

    expect(dto.lastMessage).toBeUndefined()
    expect(unreadable).toHaveBeenCalledWith('forwardingScore')
    expect(ChatDto.parse(dto)).toEqual(dto)
  })

  it('is left out of a channel and of a group chat too', () => {
    const channel = mapChannel(sparse({ id: id('1@newsletter'), lastMessage: broken }), OPTIONS)
    const group = mapGroupChat(
      sparse({
        ...CHAT,
        id: id('g@g.us'),
        createdAt: 1_761_577_446,
        participants: [],
        lastMessage: broken
      }),
      OPTIONS
    )

    expect(ChannelDto.parse(channel).lastMessage).toBeUndefined()
    expect(GroupChatDto.parse(group).lastMessage).toBeUndefined()
  })

  it('stays when it fits', () => {
    const dto = mapChat(sparse({ ...CHAT, lastMessage: sparse<MessageSource>(MESSAGE) }), OPTIONS)

    expect(dto.lastMessage?.type).toBe('location')
  })
})

describe('the DTOs accept what a real account leaves out', () => {
  it('a contact without pushname, section header, number or type', () => {
    const dto = mapContact(sparse(without(CONTACT, 'pushname', 'sectionHeader', 'number', 'type')))

    expect(ContactDto.parse(dto)).toEqual(dto)
  })

  // wwebjs 1.34.8 `GET contacts` answered 500: `isEnterprise` (and `statusMute`) are copied from the
  // WhatsApp Web model, which does not always carry them
  it.each([
    'isBusiness',
    'isEnterprise',
    'isGroup',
    'isMe',
    'isMyContact',
    'isUser',
    'isWAContact',
    'isBlocked',
    'statusMute'
  ])('a contact without %s is delivered with it false', field => {
    const dto = mapContact(sparse(without(CONTACT, field)))

    expect(dto[field as keyof ContactDto]).toBe(false)
    expect(ContactDto.parse(dto)).toEqual(dto)
  })

  // The shape wwebjs 1.34.8 delivers for a real address book (keys and types only, redacted)
  it('a contact as 1.34.8 delivers it: number null, verifiedLevel a number, no isEnterprise or statusMute', () => {
    const dto = mapContact(
      sparse({
        ...without(CONTACT, 'isEnterprise', 'statusMute', 'pushname', 'sectionHeader'),
        number: null,
        verifiedLevel: 2,
        verifiedName: 'Shop',
        labels: []
      })
    )

    expect(dto).toMatchObject({ isEnterprise: false, statusMute: false, verifiedLevel: '2' })
    expect(dto).not.toHaveProperty('number')
    expect(ContactDto.parse(dto)).toEqual(dto)
  })

  it('a business profile whose link flag is isProfileLinked, as the runtime spells it', () => {
    const dto = mapBusinessContact(
      sparse({
        ...CONTACT,
        isBusiness: true,
        businessProfile: {
          id: id('100000000000001@lid'),
          categories: [],
          profileOptions: { commerceExperience: 'none', cartEnabled: false },
          isProfileLinked: true,
          isProfileLocked: false
        }
      })
    )

    expect(dto.businessProfile.ifProfileLinked).toBe(true)
    expect(BusinessContactDto.parse(dto)).toEqual(dto)
  })

  it('a business profile without link flag, categories or profile options', () => {
    const dto = mapBusinessContact(
      sparse({ ...CONTACT, businessProfile: { id: id('100000000000001@lid') } })
    )

    expect(dto.businessProfile).toMatchObject({ ifProfileLinked: false, categories: [] })
    expect(BusinessContactDto.parse(dto)).toEqual(dto)
  })

  it('a contact with every flag missing', () => {
    const dto = mapContact(sparse({ id: id('100000000000001@lid') }))

    expect(ContactDto.parse(dto)).toEqual(dto)
  })

  it('a chat without its flags and counters', () => {
    const dto = mapChat(sparse({ id: id('100000000000001@lid') }), OPTIONS)

    expect(dto).toMatchObject({ isGroup: false, isMuted: false, unreadCount: 0, pinned: false })
    expect(ChatDto.parse(dto)).toEqual(dto)
  })

  it('a group chat without its flags, counters and with participants without admin flags', () => {
    const dto = mapGroupChat(
      sparse({
        id: id('g@g.us'),
        createdAt: 1_761_577_446,
        participants: [{ id: id('100000000000001@lid') }]
      }),
      OPTIONS
    )

    expect(dto.isGroup).toBe(true)
    expect(dto.participants[0]).toEqual({
      id: '100000000000001@lid',
      isAdmin: false,
      isSuperAdmin: false
    })
    expect(GroupChatDto.parse(dto)).toEqual(dto)
  })

  it('a channel without its flags and counters', () => {
    const dto = mapChannel(sparse({ id: id('1@newsletter') }), OPTIONS)

    expect(dto).toMatchObject({
      isChannel: true,
      isGroup: false,
      isReadOnly: false,
      isMuted: false,
      unreadCount: 0
    })
    expect(ChannelDto.parse(dto)).toEqual(dto)
  })

  it('a business contact whose profile has no tag or business hours', () => {
    const dto = mapBusinessContact(
      sparse({
        ...without(CONTACT, 'pushname', 'sectionHeader'),
        businessProfile: {
          id: id('100000000000001@lid'),
          categories: [],
          profileOptions: { commerceExperience: 'none', cartEnabled: false },
          ifProfileLinked: false
        }
      })
    )

    expect(BusinessContactDto.parse(dto)).toEqual(dto)
  })

  it('a label without color', () => {
    const dto = mapLabel(sparse({ id: '1', name: 'Clients' }))

    expect(LabelDto.parse(dto)).toEqual(dto)
  })

  it('a chat without name or mute expiration', () => {
    const dto = mapChat(sparse(without(CHAT, 'name', 'muteExpiration')), OPTIONS)

    expect(ChatDto.parse(dto)).toEqual(dto)
  })

  it('a group chat without name', () => {
    const dto = mapGroupChat(
      sparse({
        ...without(CHAT, 'name'),
        id: id('g@g.us'),
        isGroup: true,
        createdAt: 1_761_577_446,
        participants: []
      }),
      OPTIONS
    )

    expect(GroupChatDto.parse(dto)).toEqual(dto)
  })

  it('a channel without name, description, timestamp or mute expiration', () => {
    const dto = mapChannel(
      sparse({
        id: id('1@newsletter'),
        isChannel: true,
        isGroup: false,
        isReadOnly: false,
        unreadCount: 0,
        isMuted: false
      }),
      OPTIONS
    )

    expect(ChannelDto.parse(dto)).toEqual(dto)
  })

  it('a membership request without method, creator or time', () => {
    const dto = mapMembershipRequest(sparse({ id: id('100000000000003@lid') }))

    expect(MembershipRequestDto.parse(dto)).toEqual(dto)
  })

  it('a group notification without author or time', () => {
    const dto = mapGroupNotification(
      sparse({
        id: id('false_g@g.us_3EB0CCCC'),
        chatId: 'g@g.us',
        type: 'subject',
        body: '',
        recipientIds: []
      })
    )

    expect(GroupNotificationDto.parse(dto)).toEqual(dto)
  })

  it('a broadcast, a call, an order, a payment and the client info with fields missing', () => {
    const broadcast = mapBroadcast(
      sparse({ id: id('status@broadcast'), totalCount: 0, unreadCount: 0, msgs: [] }),
      OPTIONS
    )
    const call = mapCall(
      sparse({
        id: 'ABC',
        isVideo: false,
        isGroup: false,
        fromMe: false,
        canHandleLocally: false,
        webClientShouldHandle: false
      })
    )
    const order = mapOrder(sparse({ products: [{ id: 'p1', quantity: 1 }] }))
    const payment = mapPayment(
      sparse({ id: id('true_x_1'), paymentAmount1000: 1000, paymentStatus: 1, paymentTxnStatus: 1 })
    )
    const info = mapClientInfo(sparse({ wid: id('100000000000001@lid'), me: id('x@lid') }))

    expect(BroadcastDto.parse(broadcast)).toEqual(broadcast)
    expect(CallDto.parse(call)).toEqual(call)
    expect(OrderDto.parse(order)).toEqual(order)
    expect(PaymentDto.parse(payment)).toEqual(payment)
    expect(ClientInfoDto.parse(info)).toEqual(info)
  })

  it('a reaction without text, time or sender, and a reaction list without emoji', () => {
    const reaction = mapReaction(
      sparse({ id: id('true_x_9'), msgId: id('true_x_1'), orphan: 0, read: false })
    )
    const list = mapReactionList({
      id: 'r1',
      aggregateEmoji: undefined,
      hasReactionByMe: false,
      senders: []
    })

    expect(ReactionDto.parse(reaction)).toEqual(reaction)
    expect(ReactionListDto.parse(list)).toEqual(list)
  })
})
