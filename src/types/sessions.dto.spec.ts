import { PairingCodeBody } from './sessions.dto.js'

describe('pairing code body', () => {
  it.each([
    { phoneNumber: '5215500000001' },
    { phoneNumber: ' 5215500000001 ', showNotification: false },
    { phoneNumber: '1234567' }
  ])('accepts %j', body => {
    expect(PairingCodeBody.safeParse(body).success).toBe(true)
  })

  it.each([
    {},
    { phoneNumber: '+5215500000001' },
    { phoneNumber: '52 155 0000 0001' },
    { phoneNumber: '123456' },
    { phoneNumber: '1234567890123456' },
    { phoneNumber: '5215500000001', showNotification: 'yes' },
    { phoneNumber: '5215500000001', intervalMs: 1000 }
  ])('refuses %j', body => {
    expect(PairingCodeBody.safeParse(body).success).toBe(false)
  })
})
