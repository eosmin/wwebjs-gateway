const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// JSON with the keys of every object sorted, so two requests that differ only in key order (or in
// keys set to undefined) give the same string
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    isPlainObject(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested
  )
}
