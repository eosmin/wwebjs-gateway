// Postgres refuses U+0000 in `text` and `jsonb` (error 22021), so a value that reaches the database
// with one is lost. These helpers walk plain JSON-like values (strings, arrays, plain objects).

const NUL = '\u0000'

// Parsers such as fast-querystring build objects with an odd prototype chain, so the check is on the
// tag and not on the prototype; Date, Map, Buffer and the like are left alone
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]'

// Iterative: a hostile body can nest deeper than the call stack allows
export function hasNul(value: unknown): boolean {
  const pending: unknown[] = [value]
  for (let item = pending.pop(); pending.length > 0 || item !== undefined; item = pending.pop()) {
    if (typeof item === 'string') {
      if (item.includes(NUL)) return true
    } else if (Array.isArray(item)) {
      for (const child of item as unknown[]) pending.push(child)
    } else if (isPlainObject(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (key.includes(NUL)) return true
        pending.push(child)
      }
    }
  }
  return false
}

// The same value without any NUL in its strings or keys; the very same reference when it had none
export function stripNul<T>(value: T): T {
  if (!hasNul(value)) return value
  return strip(value) as T
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(NUL, '')
  if (Array.isArray(value)) return value.map(strip)
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key.replaceAll(NUL, ''), strip(item)])
    )
  }
  return value
}
