import { buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import type { StoredMessage } from '../database/models.js'

import { toMessageDto, toNewStoredMessage } from './event-pipeline.storage.js'

const SENT = '2026-10-27T12:00:00.000Z'
const RECEIVED = '2026-10-27T12:00:09.000Z'

const dto = buildMessageDto({
  id: 'm1',
  chatId: 'chat@c.us',
  fromMe: false,
  body: 'hello',
  sentAt: SENT,
  receivedAt: RECEIVED,
  raw: { text: 'hello' },
  origin: { kind: 'click_to_whatsapp_ad', title: 'Ad' }
})

describe('toNewStoredMessage', () => {
  it('maps an incoming message to its row', () => {
    const row = toNewStoredMessage('s1', dto, true)

    expect(row).toMatchObject({
      id: 'm1',
      sessionId: 's1',
      chatId: 'chat@c.us',
      direction: 'in',
      fromMe: false,
      type: 'chat',
      body: 'hello',
      hasMedia: false,
      ack: 1,
      origin: dto.origin
    })
    expect(row.sentAt).toEqual(new Date(SENT))
    expect(row.receivedAt).toEqual(new Date(RECEIVED))
    expect(row.dto).toEqual(JSON.parse(JSON.stringify(dto)))
  })

  it('marks the messages of the session as outgoing and leaves the origin out when there is none', () => {
    const row = toNewStoredMessage('s1', buildMessageDto({ fromMe: true }), true)

    expect(row.direction).toBe('out')
    expect('origin' in row).toBe(false)
  })

  it('drops the keys that are undefined, which Prisma would refuse in a Json column', () => {
    const row = toNewStoredMessage(
      's1',
      buildMessageDto({ duration: undefined, author: undefined }),
      true
    )

    expect(Object.keys(row.dto as object)).not.toContain('duration')
    expect(Object.keys(row.dto as object)).not.toContain('author')
  })

  it('keeps neither the text nor the raw copy when bodies are not stored', () => {
    const row = toNewStoredMessage('s1', dto, false)

    expect(row.body).toBeNull()
    expect(row.dto).toMatchObject({ id: 'm1', body: '' })
    expect(JSON.stringify(row.dto)).not.toContain('hello')
    expect(Object.keys(row.dto as object)).not.toContain('raw')
  })
})

describe('toMessageDto', () => {
  const stored = (value: unknown): StoredMessage => ({ dto: value }) as unknown as StoredMessage

  it('reads back what was stored', () => {
    const row = toNewStoredMessage('s1', dto, true)

    expect(toMessageDto(stored(row.dto))).toEqual(dto)
  })

  it('gives undefined for a row that no longer fits the DTO', () => {
    expect(toMessageDto(stored({ id: 'm1' }))).toBeUndefined()
    expect(toMessageDto(stored(null))).toBeUndefined()
  })
})
