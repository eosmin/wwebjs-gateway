import { WA_EVENT_NAMES, WA_EVENTS } from '../../src/types/events.js'

import { renderEvents } from './events-doc.js'

describe('renderEvents', () => {
  const doc = renderEvents()

  it.each(WA_EVENT_NAMES)('documents %s with when it fires', name => {
    const section = doc.split(`### \`${name}\`\n`)[1]?.split(/\n#{2,3} /)[0] ?? ''

    expect(section).toContain(WA_EVENTS[name].fires)
  })

  it('lists the events in the order of WA_EVENT_NAMES, each once', () => {
    const headings = [...doc.matchAll(/^### `([a-z_]+)`$/gm)].map(match => match[1])

    expect(headings).toEqual([...WA_EVENT_NAMES])
  })

  it('names the data type of an event that carries one, and links to it', () => {
    const section = doc.split('### `message`\n')[1]?.split('\n### ')[0] ?? ''

    expect(section).toContain('`data` is a [MessageDto](#messagedto).')
  })

  it('shows a full envelope as the example of an event with a plain payload', () => {
    const section = doc.split('### `qr`\n')[1]?.split('\n### ')[0] ?? ''

    expect(section).toContain('"event": "qr"')
    expect(section).toContain('"sessionId": "support-line"')
  })

  it('says an event without data has an empty object', () => {
    const section = doc.split('### `ready`\n')[1]?.split('\n### ')[0] ?? ''

    expect(section).toContain('`data` is an empty object.')
  })

  it('describes the data types events carry once each, with their fields and an example', () => {
    const types = doc.split('## Data types\n')[1] ?? ''
    const names = [...types.matchAll(/^### (\w+Dto)$/gm)].map(match => match[1])

    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining(['MessageDto', 'OriginDto', 'GroupNotificationDto', 'PollVoteDto'])
    )
    expect(types).toContain('| `ack` | integer or null | yes |')
    expect(types).toContain('| `filename` | string or null | no |')
    expect(types).toContain('"kind": "click_to_whatsapp_ad"')
  })

  it('shows the types of a field: an enum, a list of data types, an ISO date and a union', () => {
    expect(doc).toContain('| `status` | `created`, `starting`')
    expect(doc).toContain('| `messages` | [MessageDto](#messagedto)[] | yes |')
    expect(doc).toContain('| `sentAt` | ISO date | yes |')
    expect(doc).toContain('| `previous` |')
    expect(doc).toContain('| `revokedMessage` | [MessageDto](#messagedto) or null | no |')
  })

  it('shows any JSON for a value whose shape WhatsApp does not fix', () => {
    expect(doc).toContain('| `participants` | any JSON | no |')
  })
})
