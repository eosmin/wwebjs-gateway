import { hasNul, stripNul } from './nul.js'

describe('hasNul', () => {
  it('finds a NUL in a string, a nested value or a key', () => {
    expect(hasNul('a\u0000b')).toBe(true)
    expect(hasNul({ a: [{ b: 'x\u0000' }] })).toBe(true)
    expect(hasNul({ 'k\u0000': 1 })).toBe(true)
  })

  it('is false for clean values and for non-text leaves', () => {
    expect(hasNul({ a: ['x', 1, true, null, undefined], b: { c: 'ok' } })).toBe(false)
  })
})

describe('hasNul on a deeply nested value', () => {
  it('answers without overflowing the stack', () => {
    let deep: unknown = 'x'
    for (let i = 0; i < 200_000; i++) deep = [deep]

    expect(hasNul(deep)).toBe(false)
  })
})

describe('stripNul', () => {
  it('removes every NUL from strings and keys, deeply, without touching the input', () => {
    const input = { 'k\u0000': ['a\u0000b', { c: '\u0000\u0000d' }], n: 3, z: null }

    const out = stripNul(input)

    expect(out).toEqual({ k: ['ab', { c: 'd' }], n: 3, z: null })
    expect(hasNul(out)).toBe(false)
    expect(input['k\u0000'][0]).toBe('a\u0000b')
  })

  it('returns the same reference when there is nothing to remove', () => {
    const input = { a: ['x'], b: { c: 1 } }

    expect(stripNul(input)).toBe(input)
  })
})
