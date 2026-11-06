import { REDACTED } from '../infra/logger/redaction.js'
import type { EventEnvelope, WaEventName } from '../types/events.js'

import type { DeliveryEnvelope } from './delivery-queue.service.js'

export interface PayloadOptions {
  // Whether the messages keep their sanitized `raw`: the webhook's own choice, or INCLUDE_RAW
  includeRaw: boolean
  mediaMode: 'none' | 'reference' | 'inline'
  inlineMediaMaxBytes: number
}

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Where the messages of each event are in its `data`, as paths. The shape is decided by the event
// and never by walking the data: a key called `raw` or `media` elsewhere is somebody's content.
// A test ties this list to the event catalog, so an event added with a message in it fails there.
const MESSAGE_PATHS: Partial<Record<WaEventName, readonly (readonly string[])[]>> = {
  message: [[]],
  message_create: [[]],
  message_revoke_me: [[]],
  message_ciphertext: [[]],
  message_ciphertext_failed: [[]],
  media_uploaded: [[]],
  message_ack: [['message']],
  message_edit: [['message']],
  message_revoke_everyone: [['message'], ['revokedMessage']],
  contact_changed: [['message']],
  message_sent: [['message']],
  // The last message of a chat
  unread_count: [['lastMessage']],
  chat_removed: [['lastMessage']],
  chat_archived: [['chat', 'lastMessage']]
}
const BATCH_EVENT: WaEventName = 'message_batch'

export const MESSAGE_CARRYING_EVENTS: readonly string[] = [
  ...Object.keys(MESSAGE_PATHS),
  BATCH_EVENT
]

// A copy of `data` with `change` applied to what is at `path`; the same object when nothing is there
function changeAt(
  data: unknown,
  path: readonly string[],
  change: (message: Dict) => Dict
): unknown {
  if (!isDict(data)) return data
  const [key, ...rest] = path
  if (key === undefined) return change(data)
  const child = data[key]
  const changed = changeAt(child, rest, change)
  return changed === child ? data : { ...data, [key]: changed }
}

// Applies `change` to every message the event carries, on copies: the envelope is shared with the
// other subscribers of the bus (the sockets) and must stay as it is
function mapMessages(event: WaEventName, data: unknown, change: (message: Dict) => Dict): unknown {
  if (event === BATCH_EVENT) {
    if (!isDict(data) || !Array.isArray(data.messages)) return data
    return {
      ...data,
      messages: data.messages.map((item: unknown) => (isDict(item) ? change(item) : item))
    }
  }
  return (MESSAGE_PATHS[event] ?? []).reduce(
    (current, path) => changeAt(current, path, change),
    data
  )
}

function withoutKey(source: Dict, key: string): Dict {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key))
}

// Bytes a base64 text decodes to, without decoding it
function base64Bytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.floor((text.length * 3) / 4) - padding
}

function shapeMedia(message: Dict, options: PayloadOptions): Dict {
  const media = message.media
  if (!isDict(media)) return message
  if (options.mediaMode === 'none') return withoutKey(message, 'media')
  const base64 = media.base64
  if (base64 === undefined) return message
  const keep =
    options.mediaMode === 'inline' &&
    typeof base64 === 'string' &&
    base64Bytes(base64) <= options.inlineMediaMaxBytes
  return keep ? message : { ...message, media: withoutKey(media, 'base64') }
}

// The data is a DTO, so it is JSON; the schema of the queue says so, the event types do not
const asJson = (data: unknown): DeliveryEnvelope['data'] => data as DeliveryEnvelope['data']

// The event as one webhook receives it: `raw` only when the webhook includes it, and the media as
// its mode says. Media is never added here, only kept or reduced.
export function shapeForWebhook(event: EventEnvelope, options: PayloadOptions): DeliveryEnvelope {
  const data = mapMessages(event.event, event.data, message => {
    const shaped = shapeMedia(message, options)
    return options.includeRaw ? shaped : withoutKey(shaped, 'raw')
  })
  return {
    id: event.id,
    event: event.event,
    sessionId: event.sessionId,
    seq: event.seq,
    timestamp: event.timestamp,
    data: asJson(data)
  }
}

// The events whose stored copy has nothing left to send: the credential in it is `[Redacted]`. The
// job in Redis carries the real one for the automatic retries; a manual retry starts from the
// stored copy, so it is refused for these.
export const REDACTED_EVENTS: readonly string[] = ['qr', 'code']

// The copy kept in the database, which a manual retry starts from: a QR and a pairing code are
// credentials of a login that is open for a minute, and inline media can weigh megabytes. Neither
// belongs in a table that is kept for days; the job in Redis carries them.
export function redactForStorage(event: DeliveryEnvelope): DeliveryEnvelope {
  const name = event.event as WaEventName
  if (name === 'qr') return { ...event, data: { qr: REDACTED } }
  if (name === 'code') return { ...event, data: { code: REDACTED } }
  const data = mapMessages(name, event.data, message => {
    const media = message.media
    return isDict(media) && 'base64' in media
      ? { ...message, media: withoutKey(media, 'base64') }
      : message
  })
  return { ...event, data: asJson(data) }
}
