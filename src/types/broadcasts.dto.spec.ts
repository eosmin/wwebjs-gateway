import { SessionBroadcastParams } from './broadcasts.dto.js'

describe('broadcast parameters', () => {
  it.each(['5215500000001@c.us', '100000000000001@lid'])('accepts the user id %s', broadcastId => {
    expect(SessionBroadcastParams.safeParse({ sessionId: 's', broadcastId }).success).toBe(true)
  })

  it.each(['', '../x', '123@g.us', 'status@broadcast', '5215500000001'])(
    'refuses the id %j',
    broadcastId => {
      expect(SessionBroadcastParams.safeParse({ sessionId: 's', broadcastId }).success).toBe(false)
    }
  )
})
