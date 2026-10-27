import { ValidationError } from '../errors.js'

export type Recipient =
  { kind: 'phone'; digits: string } | { kind: 'id'; id: string; server: string }

const USER_SERVERS = ['c.us', 'g.us', 'lid', 'newsletter'] as const
// The local part is capped so an oversized string never reaches the browser
const WA_ID_PATTERN = new RegExp(
  `^(?=[\\w.-]{1,64}@)(\\w[\\w.-]*)@(${USER_SERVERS.join('|').replaceAll('.', '\\.')})$`
)
const BROADCAST_ID = 'status@broadcast'
// E.164 allows 15 digits; the shortest real numbers have 7
const PHONE_PATTERN = /^\d{7,15}$/

export function isWaId(value: string): boolean {
  const id = value.trim()
  return id === BROADCAST_ID || WA_ID_PATTERN.test(id)
}

// `to` is either a full WhatsApp id or a phone number written with spaces, dashes, dots, parentheses
// and an optional leading `+`
export function parseRecipient(to: string): Recipient {
  const value = to.trim()
  if (value.includes('@')) {
    if (value === BROADCAST_ID) return { kind: 'id', id: value, server: 'broadcast' }
    const server = WA_ID_PATTERN.exec(value)?.[2]
    if (server === undefined) {
      throw new ValidationError('VALIDATION_ERROR', 'The recipient is not a valid WhatsApp id', {
        field: 'to'
      })
    }
    return { kind: 'id', id: value, server }
  }
  const digits = value.replace(/^\+/, '').replace(/[\s\-().]/g, '')
  if (!PHONE_PATTERN.test(digits)) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      'The recipient must be a phone number of 7 to 15 digits or a WhatsApp id',
      { field: 'to' }
    )
  }
  return { kind: 'phone', digits }
}

export function userIdFromDigits(digits: string): string {
  return `${digits}@c.us`
}
