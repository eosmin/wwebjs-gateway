import { ChatMessagesQuery, ChatResponseDto, MuteChatBody, SetChatStateBody } from './chats.dto.js'

const base = {
  archived: false,
  isGroup: false,
  isReadOnly: false,
  isMuted: false,
  muteExpiration: 0,
  name: 'x',
  timestamp: 1,
  unreadCount: 0,
  pinned: false,
  isLocked: false
}
const privateChat = { id: 'a@c.us', ...base }
const group = {
  id: 'g@g.us',
  ...base,
  isGroup: true,
  owner: 'a@c.us',
  createdAt: '2026-01-01T00:00:00.000Z',
  description: null,
  participants: [{ id: 'a@c.us', isAdmin: true, isSuperAdmin: false }]
}
const channel = {
  id: 'c@newsletter',
  name: 'x',
  description: '',
  isChannel: true,
  isGroup: false,
  isReadOnly: true,
  unreadCount: 0,
  timestamp: 1,
  isMuted: false,
  muteExpiration: 0
}

describe('ChatResponseDto', () => {
  it.each([
    ['a private chat', privateChat],
    ['a group', group],
    ['a channel', channel]
  ])('serializes %s with every field it has', (_name, chat) => {
    expect(ChatResponseDto.schema.parse(chat)).toEqual(chat)
  })
})

describe('SetChatStateBody', () => {
  it.each([
    [{ state: 'typing' }],
    [{ state: 'recording', durationMs: 25_000 }],
    [{ state: 'typing', durationMs: 1 }],
    [{ state: 'clear' }]
  ])('accepts %j', body => {
    expect(SetChatStateBody.safeParse(body).success).toBe(true)
  })

  it.each([
    [{}],
    [{ state: 'online' }],
    [{ state: 'clear', durationMs: 100 }],
    [{ state: 'typing', durationMs: 0 }],
    [{ state: 'typing', durationMs: 25_001 }],
    [{ state: 'typing', durationMs: 1.5 }],
    [{ state: 'typing', extra: 1 }]
  ])('refuses %j', body => {
    expect(SetChatStateBody.safeParse(body).success).toBe(false)
  })
})

describe('MuteChatBody', () => {
  it('takes a date or nothing, and nothing else', () => {
    expect(MuteChatBody.safeParse({}).success).toBe(true)
    expect(MuteChatBody.safeParse({ until: '2099-01-01T00:00:00.000Z' }).success).toBe(true)
    expect(MuteChatBody.safeParse({ until: 'tomorrow' }).success).toBe(false)
    expect(MuteChatBody.safeParse({ for: 10 }).success).toBe(false)
  })
})

describe('ChatMessagesQuery', () => {
  it('defaults the limit to 50 and reads fromMe as a boolean', () => {
    expect(ChatMessagesQuery.parse({})).toEqual({ limit: 50 })
    expect(ChatMessagesQuery.parse({ limit: '20', fromMe: 'false' })).toEqual({
      limit: 20,
      fromMe: false
    })
    expect(ChatMessagesQuery.parse({ fromMe: 'true' }).fromMe).toBe(true)
  })

  it.each([
    [{ limit: '0' }],
    [{ limit: '501' }],
    [{ limit: 'abc' }],
    [{ fromMe: 'maybe' }],
    [{ x: 1 }]
  ])('refuses %j', query => {
    expect(ChatMessagesQuery.safeParse(query).success).toBe(false)
  })
})
