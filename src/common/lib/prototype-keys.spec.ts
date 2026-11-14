import { hasPrototypeKey } from './prototype-keys.js'

// JSON.parse makes `__proto__` an own property, which is what a message off the wire holds
const parse = (json: string): unknown => JSON.parse(json) as unknown

describe('hasPrototypeKey', () => {
  it('finds __proto__ at the top, inside an object and inside an array', () => {
    expect(hasPrototypeKey(parse('{"__proto__":{"polluted":1}}'))).toBe(true)
    expect(hasPrototypeKey(parse('{"a":{"b":{"__proto__":null}}}'))).toBe(true)
    expect(hasPrototypeKey(parse('{"a":[1,{"__proto__":{}}]}'))).toBe(true)
  })

  it('finds constructor.prototype, as Fastify does', () => {
    expect(hasPrototypeKey(parse('{"constructor":{"prototype":{"x":1}}}'))).toBe(true)
  })

  it('leaves ordinary values alone, a plain `constructor` key included', () => {
    expect(hasPrototypeKey({ to: 'a', body: 'b', nested: [1, 'x', null, { ok: true }] })).toBe(
      false
    )
    expect(hasPrototypeKey({ constructor: 'text' })).toBe(false)
    expect(hasPrototypeKey({ proto: {} })).toBe(false)
    expect(hasPrototypeKey(null)).toBe(false)
    expect(hasPrototypeKey('__proto__')).toBe(false)
  })

  it('does not walk a binary attachment', () => {
    expect(hasPrototypeKey({ file: Buffer.alloc(1_000_000), view: new Uint8Array(10) })).toBe(false)
  })

  it('does not overflow the stack on a deeply nested value', () => {
    let deep: unknown = { leaf: 1 }
    for (let level = 0; level < 100_000; level += 1) deep = { next: deep }
    expect(hasPrototypeKey(deep)).toBe(false)
  })
})
