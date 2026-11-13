import { reviveContent, type SendJobContent } from './send-queue.job.js'

describe('reviveContent', () => {
  it('turns the dates of an event back from the ISO strings Redis hands back', () => {
    const stored = JSON.parse(
      JSON.stringify({
        type: 'event',
        name: 'x',
        startTime: new Date(1_000),
        endTime: new Date(2_000)
      })
    ) as SendJobContent

    expect(reviveContent(stored)).toMatchObject({
      startTime: new Date(1_000),
      endTime: new Date(2_000)
    })
  })

  it('leaves out the end time of an event that has none', () => {
    const stored = JSON.parse(
      JSON.stringify({ type: 'event', name: 'x', startTime: new Date(1_000) })
    ) as SendJobContent

    const revived = reviveContent(stored)

    expect(revived).toMatchObject({ startTime: new Date(1_000) })
    expect(revived).not.toHaveProperty('endTime')
  })

  it('returns any other content as it is', () => {
    const text: SendJobContent = { type: 'text', body: 'hola' }

    expect(reviveContent(text)).toBe(text)
  })
})
