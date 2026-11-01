import { CreateCallLinkBody, SessionCallParams } from './calls.dto.js'

describe('call parameters', () => {
  it.each(['3EB0C767D0A1B2C3D4E5', 'a.b-c_d'])('accepts the call id %s', callId => {
    expect(SessionCallParams.safeParse({ sessionId: 's', callId }).success).toBe(true)
  })

  it.each(['', '../x', 'a b', 'a'.repeat(129)])('refuses the call id %j', callId => {
    expect(SessionCallParams.safeParse({ sessionId: 's', callId }).success).toBe(false)
  })
})

describe('call link body', () => {
  const body = { startTime: '2026-12-01T10:00:00Z', callType: 'video' }

  it('accepts a voice or a video call', () => {
    expect(CreateCallLinkBody.safeParse(body).success).toBe(true)
    expect(CreateCallLinkBody.safeParse({ ...body, callType: 'voice' }).success).toBe(true)
  })

  it('accepts a numeric offset', () => {
    expect(
      CreateCallLinkBody.safeParse({ ...body, startTime: '2026-12-01T10:00:00+02:00' }).success
    ).toBe(true)
  })

  it.each([
    { ...body, callType: 'none' },
    { ...body, startTime: 'tomorrow' },
    { ...body, extra: 1 },
    { callType: 'video' }
  ])('refuses %j', invalid => {
    expect(CreateCallLinkBody.safeParse(invalid).success).toBe(false)
  })
})
