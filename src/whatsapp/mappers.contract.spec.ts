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

describe('the DTOs accept what a real account leaves out', () => {
  it('a contact without pushname, section header, number or type', () => {
    const dto = mapContact(sparse(without(CONTACT, 'pushname', 'sectionHeader', 'number', 'type')))

    expect(ContactDto.parse(dto)).toEqual(dto)
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
