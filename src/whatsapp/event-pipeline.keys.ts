import { createHash } from 'node:crypto'

import type { ClientEvent } from './whatsapp-client.port.js'

// The events that carry a message id are deduplicated; wwebjs can emit them again after a reconnect.
// `message_ack` counts a new ack as a new event, and `message_edit` a new text. The rest pass.
// Returns what follows `<event>:` in the Redis key, or undefined when the event is not deduplicated.
export function dedupeSuffix(event: ClientEvent): string | undefined {
  switch (event.event) {
    case 'message':
    case 'message_create':
    case 'message_revoke_me':
    case 'message_ciphertext':
    case 'message_ciphertext_failed':
    case 'media_uploaded':
      return event.data.id
    case 'message_revoke_everyone':
      return event.data.message.id
    case 'message_ack':
      return `${event.data.message.id}:${event.data.ack}`
    case 'message_edit':
      return `${event.data.message.id}:${shortHash(event.data.newBody)}`
    case 'message_reaction':
      return `${event.data.msgId}:${event.data.id}:${shortHash(event.data.reaction)}`
    default:
      return undefined
  }
}

// The message an event is about, for the events that must follow it while it is held by the order
// buffer: published right after the message, never before
export function followedMessageId(event: ClientEvent): string | undefined {
  switch (event.event) {
    case 'message_ack':
    case 'message_edit':
    case 'message_revoke_everyone':
      return event.data.message.id
    case 'message_revoke_me':
      return event.data.id
    case 'message_reaction':
      return event.data.msgId
    default:
      return undefined
  }
}

// The text of an edit or a reaction is message content, so it never goes into a key as it is
function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}
