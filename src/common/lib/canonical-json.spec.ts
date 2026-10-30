import { canonicalJson } from './canonical-json.js'

describe('canonicalJson', () => {
  it('ignores the order of the keys, at any depth', () => {
    const a = { to: 'x', content: { type: 'text', body: 'hi' } }
    const b = { content: { body: 'hi', type: 'text' }, to: 'x' }

    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('ignores keys set to undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('keeps the order of arrays and tells different values apart', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(canonicalJson({ body: 'hi' })).not.toBe(canonicalJson({ body: 'hi!' }))
  })

  it('writes a Date as its ISO string', () => {
    const date = new Date('2026-01-01T00:00:00.000Z')

    expect(canonicalJson({ at: date })).toBe('{"at":"2026-01-01T00:00:00.000Z"}')
  })
})

describe('canonicalJson (more shapes)', () => {
  it('sorts the keys of objects inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  it('sorts at depth three and keeps null', () => {
    const a = { x: { y: { b: null, a: 1 } } }
    const b = { x: { y: { a: 1, b: null } } }

    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"x":{"y":{"a":1,"b":null}}}')
  })

  it('turns an undefined inside an array into null, as JSON does', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]')
  })
})
