import {
  AdminInviteBody,
  ChannelPostBody,
  CreateChannelBody,
  ReactionSettingBody,
  SearchChannelsQuery,
  SessionChannelParams,
  SessionChannelUserParams,
  SubscribersQuery,
  UnsubscribeBody,
  UpdateChannelBody
} from './channels.dto.js'

const channel = '120363000000000001@newsletter'
const user = '5215500000001@c.us'

describe('channels parameters', () => {
  it('accepts a channel id and trims it', () => {
    expect(
      SessionChannelParams.parse({ sessionId: 's', channelId: ` ${channel} ` }).channelId
    ).toBe(channel)
  })

  it.each(['', user, '120363000000000001@g.us', 'x@lid', 'status@broadcast'])(
    'refuses the channel id %j',
    channelId => {
      expect(SessionChannelParams.safeParse({ sessionId: 's', channelId }).success).toBe(false)
    }
  )

  it('takes only a user id in the admin routes', () => {
    expect(
      SessionChannelUserParams.safeParse({ sessionId: 's', channelId: channel, userId: user })
        .success
    ).toBe(true)
    expect(
      SessionChannelUserParams.safeParse({ sessionId: 's', channelId: channel, userId: channel })
        .success
    ).toBe(false)
  })
})

describe('channels queries', () => {
  it('turns the country codes into a list of upper-case codes without repeats', () => {
    expect(SearchChannelsQuery.parse({ countryCodes: 'mx,US,mx' }).countryCodes).toEqual([
      'MX',
      'US'
    ])
  })

  it.each(['MEX', 'M', 'mx;us', 'mx,'])('refuses the country codes %j', countryCodes => {
    expect(SearchChannelsQuery.safeParse({ countryCodes }).success).toBe(false)
  })

  it('reads the booleans and numbers of a query string', () => {
    expect(
      SearchChannelsQuery.parse({ skipSubscribedNewsletters: 'true', view: '1', limit: '20' })
    ).toEqual({ skipSubscribedNewsletters: true, view: 1, limit: 20 })
  })

  it('refuses a key it does not know', () => {
    expect(SearchChannelsQuery.safeParse({ page: '2' }).success).toBe(false)
  })

  it('defaults the subscribers to 50 and caps them', () => {
    expect(SubscribersQuery.parse({}).limit).toBe(50)
    expect(SubscribersQuery.safeParse({ limit: '1001' }).success).toBe(false)
  })
})

describe('channels bodies', () => {
  it('creates a channel from a name, with an optional description and picture', () => {
    expect(CreateChannelBody.safeParse({ name: 'N' }).success).toBe(true)
    expect(CreateChannelBody.safeParse({ name: '' }).success).toBe(false)
    expect(CreateChannelBody.safeParse({ name: 'N'.repeat(101) }).success).toBe(false)
    expect(
      CreateChannelBody.safeParse({ name: 'N', picture: { url: 'https://example.com/a.png' } })
        .success
    ).toBe(true)
  })

  it('needs a name or a description to update', () => {
    expect(UpdateChannelBody.safeParse({}).success).toBe(false)
    expect(UpdateChannelBody.safeParse({ description: '' }).success).toBe(true)
  })

  it('takes the reaction setting by name, not by wwebjs code', () => {
    expect(ReactionSettingBody.safeParse({ setting: 'basic' }).success).toBe(true)
    expect(ReactionSettingBody.safeParse({ setting: 1 }).success).toBe(false)
  })

  it('invites a user id only', () => {
    expect(AdminInviteBody.safeParse({ userId: user }).success).toBe(true)
    expect(AdminInviteBody.safeParse({ userId: channel }).success).toBe(false)
  })

  it('posts text or one media file, and nothing else', () => {
    expect(ChannelPostBody.safeParse({ type: 'text', body: 'hola' }).success).toBe(true)
    expect(
      ChannelPostBody.safeParse({
        type: 'media',
        source: { url: 'https://example.com/a.png' },
        caption: 'c'
      }).success
    ).toBe(true)
    expect(
      ChannelPostBody.safeParse({ type: 'poll', name: 'Q', options: ['a', 'b'] }).success
    ).toBe(false)
    // a post is not addressed: there is no `to`, and no humanize
    expect(ChannelPostBody.safeParse({ type: 'text', body: 'hola', to: user }).success).toBe(false)
    expect(
      ChannelPostBody.safeParse({ type: 'text', body: 'hola', humanize: { typing: 'auto' } })
        .success
    ).toBe(false)
  })
})

describe('unsubscribe body', () => {
  it('may be left out, since every option is optional', () => {
    expect(UnsubscribeBody.parse(undefined)).toEqual({})
    expect(UnsubscribeBody.parse({ deleteLocalModels: true })).toEqual({ deleteLocalModels: true })
  })
})
