// Fastify refuses a JSON body that carries `__proto__` (or `constructor.prototype`) as a key, at any
// depth, with a 400. A socket message is parsed by Socket.IO, which does not, so the same check runs on
// what a socket sends, to answer the same way. Iterative: a hostile message can nest deeper than the
// call stack allows.
export function hasPrototypeKey(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === null || typeof item !== 'object') continue
    // A binary attachment holds no keys and can be a megabyte: walking it would only cost
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) continue
    if (Array.isArray(item)) {
      for (const child of item as unknown[]) pending.push(child)
      continue
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === '__proto__') return true
      if (
        key === 'constructor' &&
        child !== null &&
        typeof child === 'object' &&
        Object.hasOwn(child, 'prototype')
      ) {
        return true
      }
      pending.push(child)
    }
  }
  return false
}
