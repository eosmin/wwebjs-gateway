import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const API_KEY_PREFIX = 'wgk_'
// Characters of an API key shown in listings so an owner can tell keys apart
const KEY_DISPLAY_PREFIX_LENGTH = 8

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// A digest of `value` that cannot be guessed from a dictionary of likely values without `secret`.
// The key is derived per purpose, so the same secret gives unrelated digests for unrelated uses.
export function keyedDigest(secret: string, purpose: string, value: string): string {
  const key = createHmac('sha256', secret).update(purpose).digest()
  return createHmac('sha256', key).update(value).digest('hex')
}

// 32 random bytes as 43 url-safe characters
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface GeneratedApiKey {
  raw: string
  hash: string
  prefix: string
}

// The raw key is returned to the caller once; only the hash and the display prefix are stored
export function generateApiKey(): GeneratedApiKey {
  const raw = `${API_KEY_PREFIX}${generateToken()}`
  return { raw, hash: sha256Hex(raw), prefix: raw.slice(0, KEY_DISPLAY_PREFIX_LENGTH) }
}

// Comparing digests keeps the comparison constant-time for inputs of different lengths
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest()
  )
}

// X-Gateway-Signature value: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  if (secret === '') throw new RangeError('A webhook secret must not be empty')
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}
