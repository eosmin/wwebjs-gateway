import { AssignLabelsBody, SessionLabelParams, SetChatLabelsBody } from './labels.dto.js'

describe('labels parameters', () => {
  it.each(['1', '42', 'a-b_c.d'])('accepts the label id %s', labelId => {
    expect(SessionLabelParams.safeParse({ sessionId: 's', labelId }).success).toBe(true)
  })

  it.each(['', '../x', 'a b', 'x'.repeat(33), '1;2'])('refuses the label id %j', labelId => {
    expect(SessionLabelParams.safeParse({ sessionId: 's', labelId }).success).toBe(false)
  })
})

describe('labels bodies', () => {
  it('accepts an empty list of labels, which clears them', () => {
    expect(SetChatLabelsBody.safeParse({ labelIds: [] }).success).toBe(true)
    expect(AssignLabelsBody.safeParse({ labelIds: [], chatIds: ['a@c.us'] }).success).toBe(true)
  })

  it('refuses a repeated label or chat and unknown keys', () => {
    expect(SetChatLabelsBody.safeParse({ labelIds: ['1', '1'] }).success).toBe(false)
    expect(
      AssignLabelsBody.safeParse({ labelIds: ['1'], chatIds: ['a@c.us', 'a@c.us'] }).success
    ).toBe(false)
    expect(SetChatLabelsBody.safeParse({ labelIds: [], x: 1 }).success).toBe(false)
  })

  it('needs at least one chat and caps both lists', () => {
    expect(AssignLabelsBody.safeParse({ labelIds: ['1'], chatIds: [] }).success).toBe(false)
    const labelIds = Array.from({ length: 51 }, (_, i) => String(i))
    const chatIds = Array.from({ length: 101 }, (_, i) => `${i}@c.us`)
    expect(SetChatLabelsBody.safeParse({ labelIds }).success).toBe(false)
    expect(AssignLabelsBody.safeParse({ labelIds: [], chatIds }).success).toBe(false)
  })

  it('hands the handler the ids without the spaces around them', () => {
    expect(SetChatLabelsBody.parse({ labelIds: [' 1 '] }).labelIds).toEqual(['1'])
  })
})
