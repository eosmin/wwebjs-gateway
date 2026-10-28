import { buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import type { ReactionDto } from '../types/dto.js'

import { dedupeSuffix, followedMessageId } from './event-pipeline.keys.js'
import type { ClientEvent } from './whatsapp-client.port.js'

const message = buildMessageDto({ id: 'm1' })

const reaction: ReactionDto = {
  id: 'r1',
  orphan: 0,
  timestamp: 1,
  reaction: '👍',
  read: false,
  msgId: 'm1',
  senderId: 'someone@c.us'
}

describe('dedupeSuffix', () => {
  it.each<[string, ClientEvent, string]>([
    ['message', { event: 'message', data: message }, 'm1'],
    ['message_create', { event: 'message_create', data: message }, 'm1'],
    ['message_revoke_me', { event: 'message_revoke_me', data: message }, 'm1'],
    ['message_ciphertext', { event: 'message_ciphertext', data: message }, 'm1'],
    ['message_ciphertext_failed', { event: 'message_ciphertext_failed', data: message }, 'm1'],
    ['media_uploaded', { event: 'media_uploaded', data: message }, 'm1'],
    ['message_revoke_everyone', { event: 'message_revoke_everyone', data: { message } }, 'm1'],
    ['message_ack', { event: 'message_ack', data: { message, ack: 3 } }, 'm1:3']
  ])('keys %s by the message id (and the ack)', (_name, event, suffix) => {
    expect(dedupeSuffix(event)).toBe(suffix)
  })

  it('lays the key out as the message id, then what tells two events of it apart', () => {
    expect(dedupeSuffix({ event: 'message_ack', data: { message, ack: 3 } })).toBe('m1:3')
    expect(
      dedupeSuffix({ event: 'message_edit', data: { message, newBody: 'x', prevBody: 'y' } })
    ).toMatch(/^m1:[0-9a-f]{12}$/)
    expect(dedupeSuffix({ event: 'message_reaction', data: reaction })).toMatch(
      /^m1:r1:[0-9a-f]{12}$/
    )
  })

  it('keeps the edits of two messages apart', () => {
    const edit = (id: string): string | undefined =>
      dedupeSuffix({
        event: 'message_edit',
        data: { message: buildMessageDto({ id }), newBody: 'same', prevBody: 'before' }
      })

    expect(edit('m1')).not.toBe(edit('m2'))
  })

  it('keeps two different acks of one message apart', () => {
    const at = (ack: number): string | undefined =>
      dedupeSuffix({ event: 'message_ack', data: { message, ack } })

    expect(at(2)).not.toBe(at(3))
  })

  it('keeps two edits with different texts apart, without the text in the key', () => {
    const edit = (newBody: string): string | undefined =>
      dedupeSuffix({ event: 'message_edit', data: { message, newBody, prevBody: 'before' } })

    expect(edit('first')).not.toBe(edit('second'))
    expect(edit('first')).toBe(edit('first'))
    expect(edit('secret text')).not.toContain('secret')
  })

  it('keeps a changed reaction apart from the first one, without the emoji in the key', () => {
    const react = (emoji: string): string | undefined =>
      dedupeSuffix({ event: 'message_reaction', data: { ...reaction, reaction: emoji } })

    expect(react('👍')).not.toBe(react('❤️'))
    expect(react('👍')).toBe(react('👍'))
    expect(react('👍')).not.toContain('👍')
  })

  it('does not deduplicate the events that carry no message', () => {
    expect(dedupeSuffix({ event: 'ready', data: {} })).toBeUndefined()
    expect(dedupeSuffix({ event: 'change_state', data: { state: 'CONNECTED' } })).toBeUndefined()
  })
})

describe('followedMessageId', () => {
  it.each<[string, ClientEvent]>([
    ['message_ack', { event: 'message_ack', data: { message, ack: 2 } }],
    ['message_edit', { event: 'message_edit', data: { message, newBody: 'a', prevBody: 'b' } }],
    ['message_revoke_everyone', { event: 'message_revoke_everyone', data: { message } }],
    ['message_revoke_me', { event: 'message_revoke_me', data: message }],
    ['message_reaction', { event: 'message_reaction', data: reaction }]
  ])('names the message %s is about', (_name, event) => {
    expect(followedMessageId(event)).toBe('m1')
  })

  it('has no target for a message or an event about something else', () => {
    expect(followedMessageId({ event: 'message', data: message })).toBeUndefined()
    expect(followedMessageId({ event: 'ready', data: {} })).toBeUndefined()
  })
})
