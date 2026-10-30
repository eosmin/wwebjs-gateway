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
  MembershipRequestDto,
  MessageDto,
  MessageInfoDto,
  OrderDto,
  PaymentDto,
  PollVoteDto,
  ReactionListDto
} from '../types/dto.js'

import {
  extractOrigin,
  mapBatteryInfo,
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
  mapMessageInfo,
  mapOrder,
  mapPayment,
  mapPollVote,
  mapReactionList,
  sanitizeRaw,
  serializeId,
  type MessageMapOptions,
  type MessageSource
} from './mappers.js'

const OPTIONS: MessageMapOptions = {
  receivedAt: new Date('2026-10-27T15:04:06.500Z'),
  includeRaw: true,
  rawMaxFieldBytes: 8192
}

const id = (value: string) => ({ _serialized: value })

function message(overrides: Partial<MessageSource> = {}): MessageSource {
  return {
    id: id('false_5215500000001@c.us_3EB0AAAA'),
    ack: 1,
    deviceType: 'android',
    body: 'Hola, ¿cuál es el precio?',
    broadcast: false,
    isStatus: false,
    isGif: false,
    isEphemeral: false,
    from: '5215500000001@c.us',
    fromMe: false,
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
    to: '5215500000002@c.us',
    type: 'chat',
    links: [],
    ...overrides
  }
}

// A redacted Click-to-WhatsApp message. The real fixture replaces it at step 12.3.
const AD_RAW = {
  ctwaContext: {
    conversionSource: 'ctwa_ad',
    sourceUrl: 'https://example.com/posts/120210000000000000',
    title: 'Ad title',
    description: 'Ad text',
    thumbnailUrl: 'https://example.com/t.jpg',
    mediaUrl: 'https://example.com/m'
  }
}

describe('serializeId', () => {
  it('reads _serialized from a wwebjs id and passes strings through', () => {
    expect(serializeId(id('a@c.us'))).toBe('a@c.us')
    expect(serializeId('a@c.us')).toBe('a@c.us')
  })

  // WhatsApp Web no longer gives message keys a `_serialized`; the key is its own parts
  describe('a message key without _serialized', () => {
    it('joins fromMe, remote and id', () => {
      expect(serializeId({ fromMe: false, remote: '111@lid', id: 'ABC' })).toBe('false_111@lid_ABC')
      expect(serializeId({ fromMe: true, remote: id('111@lid'), id: 'ABC' })).toBe(
        'true_111@lid_ABC'
      )
    })

    it('adds the participant of a group message and the self marker', () => {
      expect(
        serializeId({ fromMe: false, remote: '1@g.us', id: 'ABC', participant: id('222@lid') })
      ).toBe('false_1@g.us_ABC_222@lid')
      expect(serializeId({ fromMe: true, remote: '111@lid', id: 'ABC', self: 'out' })).toBe(
        'true_111@lid_ABC_out'
      )
    })

    it('leaves out a participant and a self marker that are empty', () => {
      expect(
        serializeId({ fromMe: false, remote: '111@lid', id: 'ABC', participant: null, self: null })
      ).toBe('false_111@lid_ABC')
      expect(
        serializeId({ fromMe: false, remote: '111@lid', id: 'ABC', participant: '', self: '' })
      ).toBe('false_111@lid_ABC')
    })

    it('puts the participant before the self marker', () => {
      expect(
        serializeId({
          fromMe: true,
          remote: '1@g.us',
          id: 'ABC',
          participant: '222@lid',
          self: 'out'
        })
      ).toBe('true_1@g.us_ABC_222@lid_out')
    })

    it('rebuilds the key when _serialized is present but undefined', () => {
      expect(
        serializeId({ _serialized: undefined, fromMe: false, remote: '111@lid', id: 'ABC' })
      ).toBe('false_111@lid_ABC')
    })

    it('prefers _serialized when it is there', () => {
      expect(serializeId({ _serialized: 'x', fromMe: false, remote: '111@lid', id: 'ABC' })).toBe(
        'x'
      )
    })
  })

  it('refuses an object that is not an id instead of returning undefined', () => {
    expect(() => serializeId({} as never)).toThrow('Cannot serialize a WhatsApp id')
  })

  it('refuses a key whose parts are not usable instead of building a wrong id', () => {
    const broken = [
      { fromMe: false, id: 'ABC' },
      { fromMe: false, remote: {}, id: 'ABC' },
      { fromMe: false, remote: '111@lid' },
      { fromMe: false, remote: '111@lid', id: 'ABC', participant: {} },
      { fromMe: 'no', remote: '111@lid', id: 'ABC' }
    ]
    for (const key of broken) {
      expect(() => serializeId(key as never)).toThrow('Cannot serialize a WhatsApp id')
    }
  })
})

describe('mapMessage', () => {
  it('maps a message whose key has no _serialized, as WhatsApp Web sends it now', () => {
    const dto = mapMessage(
      message({ id: { fromMe: false, remote: '5215500000001@c.us', id: '3EB0AAAA' } }),
      OPTIONS
    )

    expect(dto.id).toBe('false_5215500000001@c.us_3EB0AAAA')
  })

  it('maps a text message to a valid MessageDto with the gateway fields', () => {
    const dto = mapMessage(message(), OPTIONS)

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto).toMatchObject({
      id: 'false_5215500000001@c.us_3EB0AAAA',
      chatId: '5215500000001@c.us',
      sentAt: '2026-10-14T17:46:40.000Z',
      receivedAt: '2026-10-27T15:04:06.500Z',
      body: 'Hola, ¿cuál es el precio?'
    })
    expect(dto.origin).toBeUndefined()
  })

  it('takes the chat from `to` on an outgoing message', () => {
    const dto = mapMessage(
      message({ fromMe: true, from: '5215500000002@c.us', to: '5215500000001@c.us' }),
      OPTIONS
    )

    expect(dto.chatId).toBe('5215500000001@c.us')
  })

  it('takes the group as the chat of an incoming group message', () => {
    const dto = mapMessage(
      message({ from: '120363000000000000@g.us', author: '5215500000001@c.us' }),
      OPTIONS
    )

    expect(dto.chatId).toBe('120363000000000000@g.us')
    expect(dto.author).toBe('5215500000001@c.us')
  })

  it('copies only the fields it names, never what else the object carries', () => {
    const source = { ...message(), downloadMedia: () => 'x', client: { circular: true } }

    expect(mapMessage(source, OPTIONS)).not.toHaveProperty('client')
    expect(mapMessage(source, OPTIONS)).not.toHaveProperty('downloadMedia')
  })

  // The typings say string, but Message.js copies the Wid objects WhatsApp Web holds
  it('serializes mentions and group mentions that arrive as wids', () => {
    const source = message({
      mentionedIds: [id('a@c.us'), 'b@c.us'] as unknown as MessageSource['mentionedIds'],
      groupMentions: [{ groupSubject: 'Team', groupJid: id('g@g.us') }],
      businessOwnerJid: id('o@c.us')
    })

    const dto = mapMessage(source, OPTIONS)

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto.mentionedIds).toEqual(['a@c.us', 'b@c.us'])
    expect(dto.groupMentions).toEqual([{ groupSubject: 'Team', groupJid: 'g@g.us' }])
    expect(dto.businessOwnerJid).toBe('o@c.us')
  })

  it('keeps the name of each poll option, which wwebjs holds as { name, localId }', () => {
    const dto = mapMessage(
      message({
        type: 'poll_creation',
        pollName: 'Lunch?',
        pollOptions: [
          { name: 'Tacos', localId: 0 },
          { name: 'Pizza', localId: 1 }
        ] as unknown as MessageSource['pollOptions']
      }),
      OPTIONS
    )

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto.pollOptions).toEqual(['Tacos', 'Pizza'])
  })

  it('copies the free-form objects wwebjs types as `object` without functions or cycles', () => {
    const buttons: Record<string, unknown> = { id: 'b1', send: () => undefined }
    buttons['self'] = buttons

    const dto = mapMessage(message({ dynamicReplyButtons: buttons }), OPTIONS)

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto.dynamicReplyButtons).toEqual({ id: 'b1', self: '[circular]' })
  })

  it('drops the fields wwebjs left null', () => {
    const source = { ...message(), author: null, location: null } as unknown as MessageSource

    const dto = mapMessage(source, OPTIONS)

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto).not.toHaveProperty('author')
    expect(dto).not.toHaveProperty('location')
  })

  it('maps location, invite, ids of edits and the misspelled event flag', () => {
    const dto = mapMessage(
      message({
        type: 'location',
        location: { latitude: '19.4', longitude: '-99.1', name: 'Zocalo' },
        inviteV4: {
          inviteCode: 'abc',
          inviteCodeExp: 1,
          groupId: 'g@g.us',
          fromId: 'a@c.us',
          toId: 'b@c.us'
        },
        latestEditMsgKey: id('true_x_1'),
        protocolMessageKey: id('true_x_2'),
        isEventCaneled: true
      }),
      OPTIONS
    )

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto.location).toEqual({ latitude: '19.4', longitude: '-99.1', name: 'Zocalo' })
    expect(dto.latestEditMsgKey).toBe('true_x_1')
    expect(dto.protocolMessageKey).toBe('true_x_2')
    expect(dto.isEventCanceled).toBe(true)
  })

  it('attaches origin and a sanitized raw when rawData carries an ad context', () => {
    const dto = mapMessage(message({ rawData: AD_RAW }), OPTIONS)

    expect(MessageDto.parse(dto)).toEqual(dto)
    expect(dto.origin).toEqual({
      kind: 'click_to_whatsapp_ad',
      conversionSource: 'ctwa_ad',
      sourceUrl: 'https://example.com/posts/120210000000000000',
      sourceId: '120210000000000000',
      title: 'Ad title',
      description: 'Ad text',
      thumbnailUrl: 'https://example.com/t.jpg',
      mediaUrl: 'https://example.com/m'
    })
    expect(dto.raw).toEqual(AD_RAW)
  })

  it('keeps origin but leaves raw out when includeRaw is off', () => {
    const dto = mapMessage(message({ rawData: AD_RAW }), { ...OPTIONS, includeRaw: false })

    expect(dto.origin?.kind).toBe('click_to_whatsapp_ad')
    expect(dto).not.toHaveProperty('raw')
  })
})

describe('extractOrigin', () => {
  it('returns nothing without a ctwaContext', () => {
    expect(extractOrigin({ body: 'hi' })).toBeUndefined()
    expect(extractOrigin({ ctwaContext: 'nope' })).toBeUndefined()
    expect(extractOrigin(null)).toBeUndefined()
    expect(extractOrigin(undefined)).toBeUndefined()
    expect(extractOrigin([])).toBeUndefined()
  })

  it('returns a bare origin for an empty ctwaContext', () => {
    expect(extractOrigin({ ctwaContext: {} })).toEqual({ kind: 'click_to_whatsapp_ad' })
  })

  it('prefers ctwaContext.sourceId over anything parsed from a link', () => {
    const origin = extractOrigin({
      ctwaContext: { sourceId: '777', sourceUrl: 'https://example.com/posts/120210000000000000' }
    })

    expect(origin?.sourceId).toBe('777')
  })

  it('falls back to the mediaUrl when the sourceUrl has no numeric id', () => {
    const origin = extractOrigin({
      ctwaContext: {
        sourceUrl: 'https://example.com/p/AbCdEf',
        mediaUrl: 'https://example.com/media/9876543210123'
      }
    })

    expect(origin?.sourceId).toBe('9876543210123')
  })

  it('leaves sourceId out when nothing yields one', () => {
    const origin = extractOrigin({
      ctwaContext: { sourceUrl: 'https://example.com/p/AbCdEf?x=12345' }
    })

    expect(origin).not.toHaveProperty('sourceId')
  })

  it('reads the click id from the context first, then from rawData', () => {
    expect(extractOrigin({ ctwaContext: { ctwaClid: 'ctx' }, ctwaClid: 'raw' })?.ctwaClid).toBe(
      'ctx'
    )
    expect(extractOrigin({ ctwaContext: {}, ctwaClid: 'raw' })?.ctwaClid).toBe('raw')
  })

  it('does not take a timestamp or a phone number for the ad id', () => {
    expect(
      extractOrigin({ ctwaContext: { sourceUrl: 'https://example.com/p/AbCdEf?t=1792000000' } })
    ).not.toHaveProperty('sourceId')
    expect(
      extractOrigin({ ctwaContext: { sourceUrl: 'https://wa.me/5215500000001' } })
    ).not.toHaveProperty('sourceId')
  })

  it('takes the id from a path segment of the link', () => {
    const origin = extractOrigin({
      ctwaContext: { sourceUrl: 'https://www.facebook.com/page/posts/120210123456789012?x=1' }
    })

    expect(origin?.sourceId).toBe('120210123456789012')
  })

  it('does not accept a numeric sourceId that lost precision', () => {
    const origin = extractOrigin({
      ctwaContext: {
        sourceId: Number('120210123456789012'),
        sourceUrl: 'https://example.com/posts/55555555555'
      }
    })

    expect(origin?.sourceId).toBe('55555555555')
  })

  it('takes a numeric id that is a safe integer', () => {
    expect(extractOrigin({ ctwaContext: { sourceId: 12345 } })?.sourceId).toBe('12345')
  })

  it('ignores fields that are not text', () => {
    const origin = extractOrigin({ ctwaContext: { title: { a: 1 }, description: '', mediaUrl: 5 } })

    expect(origin).toEqual({ kind: 'click_to_whatsapp_ad' })
  })
})

describe('sanitizeRaw', () => {
  it('returns nothing for objects that are not plain records', () => {
    expect(sanitizeRaw(new Date(), 100)).toBeUndefined()
    expect(sanitizeRaw(Buffer.from('ab'), 100)).toBeUndefined()
    expect(sanitizeRaw(new Uint8Array(2), 100)).toBeUndefined()
  })

  it('omits a data URI and a base64 blob broken into lines', () => {
    const data = `data:image/jpeg;base64,${'QUJD'.repeat(10)}`
    const lines = `${'QUJD'.repeat(5)}\n${'QUJD'.repeat(5)}`

    expect(sanitizeRaw({ data, lines }, 20)).toEqual({
      data: `[omitted:${Buffer.byteLength(data)}]`,
      lines: '[omitted:41]'
    })
  })

  it('keeps a string exactly at the limit', () => {
    expect(sanitizeRaw({ s: 'QUJD' }, 4)).toEqual({ s: 'QUJD' })
  })

  it('counts bytes, not characters, of a multibyte string that looks like base64', () => {
    // 'é' is two bytes: 3 characters, 6 bytes
    expect(sanitizeRaw({ s: 'éAB' }, 5)).toEqual({ s: 'éAB' })
  })

  it('keeps an own key named __proto__', () => {
    const raw = JSON.parse('{"__proto__": {"a": 1}}') as unknown

    const out = sanitizeRaw(raw, 100)

    expect(Object.keys(out ?? {})).toEqual(['__proto__'])
  })

  it('cuts at exactly the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 20; i++) deep = { child: deep }
    let node: unknown = sanitizeRaw(deep, 100)
    let levels = 0
    while (typeof node === 'object' && node !== null) {
      node = (node as Record<string, unknown>)['child']
      levels++
    }

    expect(levels).toBe(8)
    expect(node).toBe('[omitted:depth]')
  })

  it('returns nothing for a value that is not an object', () => {
    expect(sanitizeRaw(undefined, 100)).toBeUndefined()
    expect(sanitizeRaw('x', 100)).toBeUndefined()
    expect(sanitizeRaw([1], 100)).toBeUndefined()
  })

  it('drops functions and undefined, keeps nulls and plain values', () => {
    expect(
      sanitizeRaw({ a: 1, b: () => 1, c: undefined, d: null, e: 'x', f: [1, undefined] }, 100)
    ).toEqual({
      a: 1,
      d: null,
      e: 'x',
      f: [1, null]
    })
  })

  it('replaces binary data with its size', () => {
    const out = sanitizeRaw(
      { buffer: Buffer.from('abcd'), typed: new Uint8Array(3), ab: new ArrayBuffer(5) },
      100
    )

    expect(out).toEqual({ buffer: '[omitted:4]', typed: '[omitted:3]', ab: '[omitted:5]' })
  })

  it('replaces a base64 blob over the limit but keeps long text and short blobs', () => {
    const blob = 'QUJD'.repeat(10)
    const sentence = 'hola mundo '.repeat(10)

    const out = sanitizeRaw({ blob, short: 'QUJD', sentence }, 20)

    expect(out).toEqual({ blob: '[omitted:40]', short: 'QUJD', sentence })
  })

  it('measures the limit in bytes, not characters', () => {
    expect(sanitizeRaw({ s: 'QUJD' }, 3)).toEqual({ s: '[omitted:4]' })
  })

  it('survives a cycle', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node['self'] = node
    node['list'] = [node]

    expect(sanitizeRaw(node, 100)).toEqual({ name: 'a', self: '[circular]', list: ['[circular]'] })
  })

  it('does not call a shared (non-cyclic) object a cycle', () => {
    const shared = { n: 1 }

    expect(sanitizeRaw({ a: shared, b: shared }, 100)).toEqual({ a: { n: 1 }, b: { n: 1 } })
  })

  it('stops at the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 20; i++) deep = { child: deep }

    expect(JSON.stringify(sanitizeRaw(deep, 100))).toContain('[omitted:depth]')
  })

  it('turns bigints and dates into JSON-safe values', () => {
    const out = sanitizeRaw(
      { big: 10n, at: new Date('2026-01-01T00:00:00.000Z'), bad: new Date('x') },
      100
    )

    expect(out).toEqual({ big: '10', at: '2026-01-01T00:00:00.000Z', bad: null })
    expect(() => JSON.stringify(out)).not.toThrow()
  })
})

describe('the other mappers produce DTOs that pass their own schema', () => {
  const contact = {
    id: id('5215500000001@c.us'),
    number: '5215500000001',
    isBusiness: false,
    isEnterprise: false,
    isGroup: false,
    isMe: false,
    isMyContact: true,
    isUser: true,
    isWAContact: true,
    isBlocked: false,
    pushname: 'Ana',
    sectionHeader: '',
    statusMute: false,
    type: 'in'
  }

  const chat = {
    id: id('5215500000001@c.us'),
    archived: false,
    isGroup: false,
    isReadOnly: false,
    isMuted: false,
    muteExpiration: 0,
    name: 'Ana',
    timestamp: 1_792_000_000,
    unreadCount: 2,
    pinned: false,
    isLocked: false
  }

  it('contact', () => {
    const dto = mapContact(contact)
    expect(ContactDto.parse(dto)).toEqual(dto)
    expect(dto.id).toBe('5215500000001@c.us')
  })

  it('business contact', () => {
    const dto = mapBusinessContact({
      ...contact,
      isBusiness: true,
      businessProfile: {
        id: id('5215500000001@c.us'),
        tag: 't',
        categories: [{ id: '1', localized_display_name: 'Retail' }],
        profileOptions: { commerceExperience: 'none', cartEnabled: false },
        businessHours: {
          config: { mon: { mode: 'specific_hours', hours: [540, 1080] } },
          timezone: 'UTC'
        },
        ifProfileLinked: false,
        description: null
      }
    })

    expect(BusinessContactDto.parse(dto)).toEqual(dto)
    expect(dto.businessProfile.id).toBe('5215500000001@c.us')
    expect(dto.businessProfile).not.toHaveProperty('description')
  })

  it('chat, with and without a last message', () => {
    const bare = mapChat(chat, OPTIONS)
    const withLast = mapChat({ ...chat, lastMessage: message() }, OPTIONS)

    expect(ChatDto.parse(bare)).toEqual(bare)
    expect(bare).not.toHaveProperty('lastMessage')
    expect(ChatDto.parse(withLast)).toEqual(withLast)
    expect(withLast.lastMessage?.id).toBe('false_5215500000001@c.us_3EB0AAAA')
  })

  it('group chat', () => {
    const dto = mapGroupChat(
      {
        ...chat,
        id: id('120363000000000000@g.us'),
        isGroup: true,
        owner: id('5215500000001@c.us'),
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        description: 'd',
        participants: [{ id: id('5215500000001@c.us'), isAdmin: true, isSuperAdmin: true }]
      },
      OPTIONS
    )

    expect(GroupChatDto.parse(dto)).toEqual(dto)
    expect(dto.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(dto.participants[0]?.id).toBe('5215500000001@c.us')
  })

  it('channel', () => {
    const dto = mapChannel(
      {
        id: id('1@newsletter'),
        name: 'n',
        description: 'd',
        isChannel: true,
        isGroup: false,
        isReadOnly: true,
        unreadCount: 0,
        timestamp: 1,
        isMuted: false,
        muteExpiration: 0,
        lastMessage: message()
      },
      OPTIONS
    )

    expect(ChannelDto.parse(dto)).toEqual(dto)
  })

  it('membership request, with and without a parent group', () => {
    const base = { id: id('a@c.us'), addedBy: id('b@c.us'), requestMethod: 'InviteLink', t: 5 }
    const plain = mapMembershipRequest(base)
    const linked = mapMembershipRequest({ ...base, parentGroupId: id('g@g.us') })

    expect(MembershipRequestDto.parse(plain)).toEqual(plain)
    expect(plain).not.toHaveProperty('parentGroupId')
    expect(linked.parentGroupId).toBe('g@g.us')
  })

  it('group notification', () => {
    const dto = mapGroupNotification({
      id: id('n1'),
      author: 'a@c.us',
      body: '',
      chatId: 'g@g.us',
      recipientIds: ['b@c.us'],
      timestamp: 1,
      type: 'add'
    })

    expect(GroupNotificationDto.parse(dto)).toEqual(dto)
    expect(dto.id).toBe('n1')
  })

  it('group notification whose recipients arrive as wids', () => {
    const dto = mapGroupNotification({
      id: id('n1'),
      author: 'a@c.us',
      body: '',
      chatId: 'g@g.us',
      recipientIds: [id('b@c.us'), 'c@c.us'],
      timestamp: 1,
      type: 'add'
    })

    expect(GroupNotificationDto.parse(dto)).toEqual(dto)
    expect(dto.recipientIds).toEqual(['b@c.us', 'c@c.us'])
  })

  it('label, call, battery', () => {
    expect(mapLabel({ id: '1', name: 'VIP', hexColor: '#fff' })).toEqual({
      id: '1',
      name: 'VIP',
      hexColor: '#fff'
    })
    expect(mapBatteryInfo({ battery: 80, plugged: true })).toEqual({ battery: 80, plugged: true })

    const call = mapCall({
      id: 'c1',
      timestamp: 1,
      isVideo: false,
      isGroup: false,
      fromMe: false,
      canHandleLocally: false,
      webClientShouldHandle: false
    })
    expect(CallDto.parse(call)).toEqual(call)
    expect(call).not.toHaveProperty('from')

    const fromWid = mapCall({
      id: 'c2',
      from: id('a@c.us'),
      timestamp: 1,
      isVideo: false,
      isGroup: false,
      fromMe: false,
      canHandleLocally: false,
      webClientShouldHandle: false
    })
    expect(CallDto.parse(fromWid)).toEqual(fromWid)
    expect(fromWid.from).toBe('a@c.us')

    const cycle: Record<string, unknown> = { 'a@c.us': { state: 'ringing' } }
    cycle['self'] = cycle
    const withParticipants = mapCall({ ...call, id: 'c3', participants: cycle })
    expect(CallDto.parse(withParticipants)).toEqual(withParticipants)
    expect(withParticipants.participants).toEqual({
      'a@c.us': { state: 'ringing' },
      self: '[circular]'
    })
  })

  it('broadcast', () => {
    const dto = mapBroadcast(
      {
        id: id('status@broadcast'),
        timestamp: 1,
        totalCount: 1,
        unreadCount: 0,
        msgs: [message()]
      },
      OPTIONS
    )

    expect(BroadcastDto.parse(dto)).toEqual(dto)
  })

  it('order and payment', () => {
    const order = mapOrder({
      products: [
        { id: 'p', thumbnailUrl: 'u', currency: 'MXN', name: 'n', quantity: 2, price: '1000' }
      ],
      subtotal: '2000',
      total: '2000',
      currency: 'MXN',
      createdAt: 1
    })
    const payment = mapPayment({
      id: id('pay1'),
      paymentCurrency: 'MXN',
      paymentAmount1000: 1000,
      paymentMessageReceiverJid: id('a@c.us'),
      paymentTransactionTimestamp: 1,
      paymentStatus: 1,
      paymentTxnStatus: 1,
      paymentNote: ''
    })

    expect(OrderDto.parse(order)).toEqual(order)
    expect(PaymentDto.parse(payment)).toEqual(payment)
    expect(payment.paymentMessageReceiverJid).toBe('a@c.us')
  })

  it('client info, with and without the deprecated phone', () => {
    const base = {
      wid: id('5215500000002@c.us'),
      me: id('5215500000002@c.us'),
      platform: 'android',
      pushname: 'Bot'
    }
    const plain = mapClientInfo({ ...base, phone: null })
    const withPhone = mapClientInfo({
      ...base,
      phone: {
        wa_version: '2',
        os_version: '14',
        device_manufacturer: 'x',
        device_model: 'y',
        os_build_number: '1'
      }
    })

    expect(ClientInfoDto.parse(plain)).toEqual(plain)
    expect(plain).not.toHaveProperty('phone')
    expect(ClientInfoDto.parse(withPhone)).toEqual(withPhone)
  })

  it('message info', () => {
    const dto = mapMessageInfo({
      delivery: [{ id: id('a@c.us'), t: 1 }],
      deliveryRemaining: 0,
      played: [],
      playedRemaining: 0,
      read: [{ id: 'b@c.us', t: 2 }],
      readRemaining: 1
    })

    expect(MessageInfoDto.parse(dto)).toEqual(dto)
    expect(dto.delivery[0]?.id).toBe('a@c.us')
  })

  it('reaction list', () => {
    const dto = mapReactionList({
      id: 'r',
      aggregateEmoji: '👍',
      hasReactionByMe: false,
      senders: [
        {
          id: id('r1'),
          orphan: 0,
          timestamp: 1,
          reaction: '👍',
          read: false,
          msgId: id('m1'),
          senderId: 'a@c.us'
        }
      ]
    })

    expect(ReactionListDto.parse(dto)).toEqual(dto)
    expect(dto.senders[0]?.msgId).toBe('m1')
  })

  it('poll vote, renaming the misspelled timestamp and keeping the poll id', () => {
    const dto = mapPollVote({
      voter: 'a@c.us',
      selectedOptions: [{ id: 0, name: 'Si' }],
      interractedAtTs: 99,
      parentMessage: { id: id('poll1') }
    })

    expect(PollVoteDto.parse(dto)).toEqual(dto)
    expect(dto).toMatchObject({ interactedAtTs: 99, parentMessageId: 'poll1' })
  })

  // wwebjs 1.34.7 types `voter` as a string and the options as `{ id, name }`, but PollVote.js
  // assigns the Wid object of the sender and `{ name, localId }`
  it('poll vote as wwebjs really builds it: a wid voter and options with localId', () => {
    const dto = mapPollVote({
      voter: id('a@c.us'),
      selectedOptions: [{ localId: 2, name: 'Si' }],
      interractedAtTs: 99,
      parentMessage: { id: id('poll1') }
    })

    expect(PollVoteDto.parse(dto)).toEqual(dto)
    expect(dto.voter).toBe('a@c.us')
    expect(dto.selectedOptions).toEqual([{ id: 2, name: 'Si' }])
  })

  // PollVote.js builds `new Message(client, data.parentMessage)`, which patches nothing when the poll
  // message was not found, so its id is undefined; `parentMsgKey` still names the poll
  it('poll vote whose poll message was not found keeps the poll id from parentMsgKey', () => {
    const dto = mapPollVote({
      voter: 'a@c.us',
      selectedOptions: [],
      interractedAtTs: 99,
      parentMessage: {},
      parentMsgKey: id('poll9')
    })

    expect(PollVoteDto.parse(dto)).toEqual(dto)
    expect(dto.parentMessageId).toBe('poll9')
  })

  it('poll vote that names no poll at all is refused instead of inventing an id', () => {
    expect(() =>
      mapPollVote({ voter: 'a@c.us', selectedOptions: [], interractedAtTs: 1, parentMessage: {} })
    ).toThrow()
  })

  it('poll vote option that only has `id` and one whose id is missing', () => {
    const dto = mapPollVote({
      voter: 'a@c.us',
      selectedOptions: [{ id: 4, name: 'A' }, { name: 'B' }],
      interractedAtTs: 1,
      parentMessage: { id: id('p') }
    })

    expect(dto.selectedOptions).toEqual([
      { id: 4, name: 'A' },
      { id: 0, name: 'B' }
    ])
  })

  it('poll vote whose poll message was not found, so no option has a name', () => {
    const dto = mapPollVote({
      voter: 'a@c.us',
      selectedOptions: [{ localId: 1, name: undefined }],
      interractedAtTs: 99,
      parentMessage: { id: id('poll1') }
    })

    expect(PollVoteDto.parse(dto)).toEqual(dto)
    expect(dto.selectedOptions).toEqual([{ id: 1, name: '' }])
  })
})
