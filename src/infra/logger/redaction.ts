export const REDACTED = '[Redacted]'
const UNREADABLE = '[Unreadable]'
const CIRCULAR = '[Circular]'
const MAX_DEPTH = 8
// Bounds on what one log call can cost: the regexes below are quadratic on long runs of key-like text
const MAX_TEXT_LENGTH = 8192
const MAX_ENTRIES = 100
// Matched against the lowercased key without `-` and `_`, so `x-api-key`, `api_key` and `apiKey` agree
const SENSITIVE_FRAGMENTS = [
  'secret',
  'token',
  'password',
  'apikey',
  'authorization',
  'cookie',
  'signature',
  'privatekey',
  'credential',
  'pairing',
  'bearer'
]
// Too short to match as a fragment without catching harmless keys. `body`, `text` and `caption` are the
// content of a message, which is never logged.
const SENSITIVE_KEYS = new Set(['otp', 'jwt', 'body', 'text', 'caption'])

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '')
  return (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_FRAGMENTS.some(fragment => normalized.includes(fragment)) ||
    normalized.startsWith('qr') ||
    normalized.endsWith('qr')
  )
}

// Secrets that travel inside a string: a log line, an error message, a URL
const TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/(hooks(?:\/|%2F)inbound(?:\/|%2F))[^/?#\s"'%]+/gi, `$1${REDACTED}`],
  [/\b(Bearer|Basic|Digest)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`],
  [/\bwgk_[\w-]+/g, REDACTED],
  // WhatsApp Web QR payloads start with a ref and a key: `2@...`
  [/\b2@[\w+/=,-]{8,}/g, REDACTED],
  // Credentials inside a connection string: redis://user:pass@host
  [/(?<![\w+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]*:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // Starts only where a word starts (the lookbehind), so a long run of word characters is scanned once
  [
    /(?<![\w-])([\w-]{0,64}(?:secret|token|password|api[-_]?key|authorization|signature)[\w-]{0,64}["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi,
    `$1${REDACTED}`
  ]
]

export function scrubText(text: string): string {
  const bounded =
    text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…[truncated]` : text
  return TEXT_PATTERNS.reduce((scrubbed, [pattern, replacement]) => {
    return scrubbed.replace(pattern, replacement)
  }, bounded)
}

function read(source: () => unknown): unknown {
  try {
    return source()
  } catch {
    return UNREADABLE
  }
}

function entriesOf(value: object): [string, unknown][] {
  const record = value as Record<string, unknown>
  return Object.keys(value).map((key): [string, unknown] => [key, read(() => record[key])])
}

function describeError(error: Error): [string, unknown][] {
  const entries: [string, unknown][] = [
    ['type', read(() => error.name)],
    ['message', read(() => error.message)],
    ['stack', read(() => error.stack)]
  ]
  if (error.cause !== undefined) entries.push(['cause', error.cause])
  if (error instanceof AggregateError) entries.push(['errors', error.errors])
  return entries
}

function entriesFor(value: object): [string, unknown][] {
  const entries =
    value instanceof Map
      ? [...value]
          .slice(0, MAX_ENTRIES)
          .map(([key, entry]): [string, unknown] => [String(key), entry])
      : entriesOf(value)
  return value instanceof Error ? [...entries, ...describeError(value)] : entries
}

// Copies the value with the content of every sensitive key replaced and every string scrubbed, at any
// depth. Errors become plain objects, bytes become a size, and what lies past the depth limit or loops
// back to an ancestor is censored. It never throws: a property that cannot be read is marked.
export function redactSensitive(
  value: unknown,
  depth = 0,
  ancestors: Set<object> = new Set()
): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Date) return value
  if (value instanceof URL) return scrubText(value.href)
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`
  }
  if (depth > MAX_DEPTH) return REDACTED
  if (ancestors.has(value)) return CIRCULAR

  ancestors.add(value)
  try {
    const walk = (entry: unknown): unknown => redactSensitive(entry, depth + 1, ancestors)
    if (Array.isArray(value) || value instanceof Set) {
      const items = [...value]
      const redacted = items.slice(0, MAX_ENTRIES).map(walk)
      return items.length > MAX_ENTRIES
        ? [...redacted, `[+${items.length - MAX_ENTRIES} more]`]
        : redacted
    }
    // No prototype, so a key such as `__proto__` is stored as data instead of replacing the prototype
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, entry] of entriesFor(value)) {
      copy[key] = isSensitiveKey(key) ? REDACTED : walk(entry)
    }
    return copy
  } finally {
    ancestors.delete(value)
  }
}
