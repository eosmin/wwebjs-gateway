import { AddSuppressionBody, SuppressionParams } from './send-policy-api.dto.js'

describe('suppression parameters', () => {
  it.each([
    '5215500000001@c.us',
    '100000000000001@lid',
    '120363000000000001@g.us',
    '5215500000001'
  ])('accepts the chat %s to add', chatId => {
    expect(AddSuppressionBody.safeParse({ chatId }).success).toBe(true)
  })

  it.each(['', 'status@broadcast', 'abc', '123456', 'a@unknown', `${'1'.repeat(130)}@c.us`])(
    'refuses the chat %j to add',
    chatId => {
      expect(AddSuppressionBody.safeParse({ chatId }).success).toBe(false)
    }
  )

  it('trims a note and refuses an empty or long one and unknown fields', () => {
    expect(AddSuppressionBody.parse({ chatId: '1@lid', note: ' why ' }).note).toBe('why')
    expect(AddSuppressionBody.safeParse({ chatId: '1@lid', note: '  ' }).success).toBe(false)
    expect(AddSuppressionBody.safeParse({ chatId: '1@lid', note: 'x'.repeat(201) }).success).toBe(
      false
    )
    expect(AddSuppressionBody.safeParse({ chatId: '1@lid', reason: 'opt_out' }).success).toBe(false)
  })

  it('takes only a WhatsApp id in the path, never a phone number', () => {
    expect(SuppressionParams.safeParse({ sessionId: 's', chatId: '1@lid' }).success).toBe(true)
    expect(SuppressionParams.safeParse({ sessionId: 's', chatId: '5215500000001' }).success).toBe(
      false
    )
    expect(
      SuppressionParams.safeParse({ sessionId: 's', chatId: 'status@broadcast' }).success
    ).toBe(false)
  })
})
