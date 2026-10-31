import { ValidationError } from '../errors.js'

import { isWaId, parseRecipient, phoneDigits, userIdFromDigits } from './wa-id.js'

describe('parseRecipient', () => {
  it.each([
    ['5215500000001', '5215500000001'],
    ['+52 155 0000 0001', '5215500000001'],
    ['+52-155-(0000).0001', '5215500000001'],
    ['  15550001234 ', '15550001234']
  ])('reads %j as a phone number', (input, digits) => {
    expect(parseRecipient(input)).toEqual({ kind: 'phone', digits })
  })

  it.each([
    ['5215500000001@c.us', 'c.us'],
    ['120363000000000001@g.us', 'g.us'],
    ['5215500000001-1600000000@g.us', 'g.us'],
    ['100000000000001@lid', 'lid'],
    ['120363000000000002@newsletter', 'newsletter']
  ])('keeps %j as a WhatsApp id', (id, server) => {
    expect(parseRecipient(id)).toEqual({ kind: 'id', id, server })
  })

  it('accepts the status broadcast id', () => {
    expect(parseRecipient('status@broadcast')).toEqual({
      kind: 'id',
      id: 'status@broadcast',
      server: 'broadcast'
    })
  })

  it.each([
    '',
    '12345',
    '1234567890123456',
    'abc',
    '555@unknown.server',
    '@c.us',
    'a b@c.us',
    '++5215500000001'
  ])('rejects %j', input => {
    expect(() => parseRecipient(input)).toThrow(ValidationError)
  })
})

describe('isWaId', () => {
  it('tells ids from phone numbers', () => {
    expect(isWaId('5215500000001@c.us')).toBe(true)
    expect(isWaId('status@broadcast')).toBe(true)
    expect(isWaId('5215500000001')).toBe(false)
    expect(isWaId('x@evil.com')).toBe(false)
    expect(isWaId(' 5215500000001@c.us ')).toBe(true)
    expect(isWaId(`${'1'.repeat(65)}@c.us`)).toBe(false)
  })
})

describe('userIdFromDigits', () => {
  it('builds the contact id', () => {
    expect(userIdFromDigits('5215500000001')).toBe('5215500000001@c.us')
  })
})

describe('phoneDigits', () => {
  it('strips the plus and the separators', () => {
    expect(phoneDigits(' +52 (55) 0000-0001 ')).toBe('525500000001')
  })

  it.each(['123456', '1234567890123456', 'abc', '52550000000a', '', '1@c.us'])(
    'answers null for %j',
    value => {
      expect(phoneDigits(value)).toBeNull()
    }
  )
})
