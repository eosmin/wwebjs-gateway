import { z } from 'zod'

import { exampleOf, type Json } from './json-schema-example.js'

function exampleFor(schema: z.ZodType): Json {
  const { $defs, ...top } = z.toJSONSchema(schema) as z.core.JSONSchema.JSONSchema
  return exampleOf(top, $defs ?? {})
}

describe('exampleOf', () => {
  it('keeps the required properties and drops the optional ones', () => {
    expect(exampleFor(z.object({ a: z.string(), b: z.string().optional() }))).toEqual({
      a: 'string'
    })
  })

  it.each([
    ['a boolean', z.boolean(), false],
    ['null', z.null(), null],
    ['an enum', z.enum(['x', 'y']), 'x'],
    ['a literal', z.literal('only'), 'only'],
    ['an ISO date', z.iso.datetime(), '2026-10-27T15:04:05.123Z'],
    ['a number', z.number(), 0],
    ['an integer without bounds', z.number().int(), 0],
    ['an integer from 5', z.number().int().min(5), 5],
    ['a hint', z.string().meta({ examples: ['hola'] }), 'hola'],
    ['a list', z.array(z.boolean()), [false]],
    ['a nullable, by its value', z.string().nullable(), 'string'],
    ['a record', z.record(z.string(), z.number()), {}]
  ])('makes %s', (_label, schema, expected) => {
    expect(exampleFor(schema)).toEqual(expected)
  })

  it('follows a reference into the definitions', () => {
    const inner = z.object({ n: z.number() }).meta({ id: 'Inner' })

    expect(exampleFor(z.object({ inner }))).toEqual({ inner: { n: 0 } })
  })

  it('answers an empty object for the JSON that refers to itself', () => {
    expect(exampleFor(z.object({ any: z.json() }))).toEqual({ any: {} })
  })

  it('answers null for a schema it knows nothing about', () => {
    expect(exampleOf({})).toBeNull()
  })

  it('answers an empty object for a reference that is not defined', () => {
    expect(exampleOf({ $ref: '#/$defs/Missing' })).toEqual({})
  })

  it.each([
    ['a negative minimum, as it is', z.number().int().min(-3), -3],
    ['a minimum of zero', z.number().min(0), 0],
    ['an enum, its first member', z.enum(['b', 'a']), 'b'],
    ['a hint inside a property', z.object({ a: z.string().meta({ examples: ['x'] }) }), { a: 'x' }]
  ])('makes %s', (_label, schema, expected) => {
    expect(exampleFor(schema)).toEqual(expected)
  })
})
