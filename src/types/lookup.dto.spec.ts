import { LidPhoneQuery, NumberParams, lidPhoneIds, MAX_LID_PHONE_IDS } from './lookup.dto.js'

describe('lookup parameters', () => {
  it.each(['5215500000001', '+52 55-0000-0001', '(52) 5500.000001'])(
    'accepts the number %s',
    number => {
      expect(NumberParams.safeParse({ sessionId: 's', number }).success).toBe(true)
    }
  )

  it.each(['123456', '1'.repeat(16), 'abc', '5215500000001@c.us', ''])(
    'refuses the number %j',
    number => {
      expect(NumberParams.safeParse({ sessionId: 's', number }).success).toBe(false)
    }
  )

  it('splits, trims and deduplicates the ids', () => {
    const query = LidPhoneQuery.parse({ ids: ' 1@lid, 5215500000001@c.us ,1@lid,' })

    expect(lidPhoneIds(query)).toEqual(['1@lid', '5215500000001@c.us'])
  })

  it.each([
    '',
    ' , ',
    '120363000000000001@g.us',
    'status@broadcast',
    'x@lid,nonsense',
    Array.from({ length: MAX_LID_PHONE_IDS + 1 }, (_, i) => `${i}@lid`).join(',')
  ])('refuses the ids %j', ids => {
    expect(LidPhoneQuery.safeParse({ ids }).success).toBe(false)
  })

  it('accepts the most ids allowed', () => {
    const ids = Array.from({ length: MAX_LID_PHONE_IDS }, (_, i) => `${i}@lid`).join(',')

    expect(LidPhoneQuery.safeParse({ ids }).success).toBe(true)
  })
})
