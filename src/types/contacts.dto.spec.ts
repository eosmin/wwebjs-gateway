import {
  AddressbookParams,
  SaveAddressbookBody,
  SessionContactParams,
  addressbookNumber
} from './contacts.dto.js'

describe('contacts parameters', () => {
  it.each(['5215500000001@c.us', '100000000000001@lid'])('accepts the contact id %s', contactId => {
    expect(SessionContactParams.safeParse({ sessionId: 's', contactId }).success).toBe(true)
  })

  it.each(['', '5215500000001', '120363000000000001@g.us', 'x@newsletter', 'status@broadcast'])(
    'refuses the contact id %j',
    contactId => {
      expect(SessionContactParams.safeParse({ sessionId: 's', contactId }).success).toBe(false)
    }
  )

  it('hands the handler the id without the spaces around it', () => {
    const params = SessionContactParams.parse({ sessionId: 's', contactId: ' 5215500000001@c.us ' })

    expect(params.contactId).toBe('5215500000001@c.us')
    expect(
      AddressbookParams.parse({ sessionId: 's', contactId: ' 5215500000001@c.us ' }).contactId
    ).toBe('5215500000001@c.us')
  })

  it('keys the address book by the phone of a @c.us id', () => {
    const params = AddressbookParams.parse({ sessionId: 's', contactId: '5215500000001@c.us' })

    expect(addressbookNumber(params.contactId)).toBe('5215500000001')
  })

  it.each([
    '100000000000001@lid',
    '123@c.us',
    'abc@c.us',
    '5215-500.0001@c.us',
    '52_155000001@c.us'
  ])('refuses %s for the address book', contactId => {
    expect(AddressbookParams.safeParse({ sessionId: 's', contactId }).success).toBe(false)
  })

  it('needs a first name, allows an empty last name and refuses unknown keys', () => {
    expect(SaveAddressbookBody.safeParse({ firstName: 'A', lastName: '' }).success).toBe(true)
    expect(SaveAddressbookBody.safeParse({ firstName: '', lastName: 'B' }).success).toBe(false)
    expect(SaveAddressbookBody.safeParse({ firstName: 'A', lastName: 'B', x: 1 }).success).toBe(
      false
    )
  })
})
