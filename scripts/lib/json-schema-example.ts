import type { z } from 'zod'

type JsonSchema = z.core.JSONSchema.JSONSchema
type Definitions = Record<string, JsonSchema>
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

// Zod bounds every integer to the safe range; that is not a value worth showing
const isSafeBound = (value: number): boolean => Math.abs(value) >= Number.MAX_SAFE_INTEGER

function referenced(ref: string, definitions: Definitions): JsonSchema | undefined {
  return definitions[ref.slice(ref.lastIndexOf('/') + 1)]
}

// The smallest value that satisfies the schema: required properties only, the first enum member,
// a placeholder for text. Documentation examples come from here, so they cannot drift from the schema.
export function exampleOf(schema: JsonSchema, definitions: Definitions = {}): Json {
  if (schema.$ref !== undefined) {
    const target = referenced(schema.$ref, definitions)
    // z.json() refers to itself: any JSON will do
    return target === undefined || schema.$ref.includes('__schema')
      ? {}
      : exampleOf(target, definitions)
  }
  const hinted = schema.examples?.[0]
  if (hinted !== undefined) return hinted as Json
  if (schema.const !== undefined) return schema.const
  if (schema.enum !== undefined) return schema.enum[0] ?? null
  if (schema.anyOf !== undefined) {
    const variant = schema.anyOf.find(
      option => typeof option === 'object' && option.type !== 'null'
    )
    return typeof variant === 'object' ? exampleOf(variant, definitions) : null
  }
  if (Array.isArray(schema.type)) {
    // a nullable primitive: show the value, not the null
    const type = schema.type.find(name => name !== 'null')
    return type === undefined ? null : exampleOf({ ...schema, type }, definitions)
  }
  switch (schema.type) {
    case 'string':
      return schema.format === 'date-time' ? '2026-10-27T15:04:05.123Z' : 'string'
    case 'integer':
    case 'number': {
      const { minimum } = schema
      return minimum !== undefined && !isSafeBound(minimum) ? minimum : 0
    }
    case 'boolean':
      return false
    case 'null':
      return null
    case 'array': {
      const { items } = schema
      return typeof items === 'object' && !Array.isArray(items)
        ? [exampleOf(items, definitions)]
        : []
    }
    case 'object': {
      const result: { [key: string]: Json } = {}
      for (const name of schema.required ?? []) {
        const property = schema.properties?.[name]
        if (typeof property === 'object') result[name] = exampleOf(property, definitions)
      }
      return result
    }
    default:
      return null
  }
}
