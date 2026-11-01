import {
  CreateGroupBody,
  GroupParticipantsBody,
  GroupSettingsBody,
  MembershipRequestsActionBody,
  SessionGroupParams,
  SessionInviteParams,
  UpdateGroupBody,
  inviteUrl
} from './groups.dto.js'

const user = '5215500000001@c.us'

describe('groups parameters', () => {
  it('accepts a group id and trims it', () => {
    expect(
      SessionGroupParams.parse({ sessionId: 's', groupId: ' 120363000000000001@g.us ' }).groupId
    ).toBe('120363000000000001@g.us')
  })

  it.each(['', user, '100000000000001@lid', 'x@newsletter', 'status@broadcast'])(
    'refuses the group id %j',
    groupId => {
      expect(SessionGroupParams.safeParse({ sessionId: 's', groupId }).success).toBe(false)
    }
  )

  it('takes the code of an invite, not the link', () => {
    expect(
      SessionInviteParams.safeParse({ sessionId: 's', inviteCode: 'AbCdEfGhIjKlMnOpQrStUv' })
        .success
    ).toBe(true)
    expect(
      SessionInviteParams.safeParse({
        sessionId: 's',
        inviteCode: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv'
      }).success
    ).toBe(false)
  })

  it('builds the invite link from the code', () => {
    expect(inviteUrl('AbC')).toBe('https://chat.whatsapp.com/AbC')
  })
})

describe('groups bodies', () => {
  it('needs a subject and at least one participant to create a group', () => {
    expect(CreateGroupBody.safeParse({ subject: 'G', participants: [user] }).success).toBe(true)
    expect(CreateGroupBody.safeParse({ subject: 'G', participants: [] }).success).toBe(false)
    expect(CreateGroupBody.safeParse({ subject: '', participants: [user] }).success).toBe(false)
  })

  it('refuses a participant that is a group, a repeat, and more than 256', () => {
    expect(
      CreateGroupBody.safeParse({ subject: 'G', participants: ['120363000000000001@g.us'] }).success
    ).toBe(false)
    expect(CreateGroupBody.safeParse({ subject: 'G', participants: [user, user] }).success).toBe(
      false
    )
    const many = Array.from(
      { length: 257 },
      (_, index) => `52155${String(index).padStart(8, '0')}@c.us`
    )
    expect(CreateGroupBody.safeParse({ subject: 'G', participants: many }).success).toBe(false)
  })

  it('refuses a subject over 100 characters and an unknown key', () => {
    expect(
      CreateGroupBody.safeParse({ subject: 'x'.repeat(101), participants: [user] }).success
    ).toBe(false)
    expect(CreateGroupBody.safeParse({ subject: 'G', participants: [user], x: 1 }).success).toBe(
      false
    )
  })

  it('needs something to change, and lets an empty description clear it', () => {
    expect(UpdateGroupBody.safeParse({}).success).toBe(false)
    expect(UpdateGroupBody.safeParse({ description: '' }).success).toBe(true)
    expect(GroupSettingsBody.safeParse({}).success).toBe(false)
    expect(GroupSettingsBody.safeParse({ messagesAdminsOnly: false }).success).toBe(true)
  })

  it('accepts options only for the action add', () => {
    const base = { participants: [user], options: { sleep: [250, 500] } }
    expect(GroupParticipantsBody.safeParse({ ...base, action: 'add' }).success).toBe(true)
    expect(GroupParticipantsBody.safeParse({ ...base, action: 'remove' }).success).toBe(false)
    expect(
      GroupParticipantsBody.safeParse({ participants: [user], action: 'promote' }).success
    ).toBe(true)
    expect(GroupParticipantsBody.safeParse({ participants: [user], action: 'kick' }).success).toBe(
      false
    )
  })

  it('takes one requester, a list, or none', () => {
    expect(MembershipRequestsActionBody.safeParse({}).success).toBe(true)
    expect(MembershipRequestsActionBody.safeParse({ requesterIds: user }).success).toBe(true)
    expect(MembershipRequestsActionBody.safeParse({ requesterIds: [user] }).success).toBe(true)
    expect(MembershipRequestsActionBody.safeParse({ requesterIds: [] }).success).toBe(false)
  })

  it('bounds the pause between participants so a call fits the timeout', () => {
    const body = (sleep: unknown, count = 1) => ({
      action: 'add',
      participants: Array.from(
        { length: count },
        (_, i) => `52155${String(i).padStart(8, '0')}@c.us`
      ),
      options: { sleep }
    })
    expect(GroupParticipantsBody.safeParse(body(5000, 24)).success).toBe(true)
    expect(GroupParticipantsBody.safeParse(body(5001)).success).toBe(false)
    expect(GroupParticipantsBody.safeParse(body(5000, 25)).success).toBe(false)
    expect(GroupParticipantsBody.safeParse(body([500, 250])).success).toBe(false)
    expect(
      MembershipRequestsActionBody.safeParse({ requesterIds: [user], sleep: [0, 5000] }).success
    ).toBe(true)
    expect(MembershipRequestsActionBody.safeParse({ sleep: [900, 100] }).success).toBe(false)
  })
})
