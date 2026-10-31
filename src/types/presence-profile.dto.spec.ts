import {
  SetAccountSettingsBody,
  SetDisplayNameBody,
  SetPresenceBody,
  SetProfilePictureBody,
  SetProfileStatusBody
} from './presence-profile.dto.js'

describe('presence and profile bodies', () => {
  it('accepts only available and unavailable as presence', () => {
    expect(SetPresenceBody.safeParse({ state: 'available' }).success).toBe(true)
    expect(SetPresenceBody.safeParse({ state: 'unavailable' }).success).toBe(true)
    expect(SetPresenceBody.safeParse({ state: 'online' }).success).toBe(false)
    expect(SetPresenceBody.safeParse({ state: 'available', other: 1 }).success).toBe(false)
  })

  it('limits the about text to 139 characters and the name to 25, and trims them', () => {
    expect(SetProfileStatusBody.safeParse({ status: 'a'.repeat(139) }).success).toBe(true)
    expect(SetProfileStatusBody.safeParse({ status: 'a'.repeat(140) }).success).toBe(false)
    expect(SetProfileStatusBody.safeParse({ status: '   ' }).success).toBe(false)
    expect(SetDisplayNameBody.safeParse({ displayName: 'a'.repeat(25) }).success).toBe(true)
    expect(SetDisplayNameBody.safeParse({ displayName: 'a'.repeat(26) }).success).toBe(false)
    expect(SetDisplayNameBody.parse({ displayName: ' Soporte ' })).toEqual({
      displayName: 'Soporte'
    })
  })

  it('takes the picture from base64, a url or a message, and nothing else', () => {
    const ok = (source: object) => SetProfilePictureBody.safeParse({ source }).success

    expect(ok({ base64: 'AAAA', mimetype: 'image/png' })).toBe(true)
    expect(ok({ url: 'https://example.com/a.png' })).toBe(true)
    expect(ok({ messageId: 'true_5215500000001@c.us_ABC' })).toBe(true)
    expect(ok({ base64: 'AAAA' })).toBe(false)
    expect(SetProfilePictureBody.safeParse({}).success).toBe(false)
  })

  it('needs at least one setting and refuses an unknown one', () => {
    expect(SetAccountSettingsBody.safeParse({}).success).toBe(false)
    expect(SetAccountSettingsBody.safeParse({ backgroundSync: false }).success).toBe(true)
    expect(SetAccountSettingsBody.safeParse({ autoDownloadAudio: 'yes' }).success).toBe(false)
    expect(SetAccountSettingsBody.safeParse({ other: true }).success).toBe(false)
  })
})
