import { z } from 'zod'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// The OpenAPI schema of a request body that cannot be a nestjs-zod DTO (a union of variants cannot be
// the base of a class). Zod puts the parts the variants share in `$defs`, and a `$ref` into them
// would not resolve once the schema sits inside the OpenAPI document, so they are inlined here. The
// schemas have no cycles.
export function requestSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $defs: defs = {}, ...root } = z.toJSONSchema(schema, {
    unrepresentable: 'any'
  }) as Record<string, Json> & { $defs?: Record<string, Json> }

  const inline = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(inline)
    if (node === null || typeof node !== 'object') return node
    const ref = node['$ref']
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      const target = defs[ref.slice('#/$defs/'.length)]
      if (target === undefined) throw new Error(`Unresolved JSON schema reference ${ref}`)
      return inline(target)
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value)]))
  }
  return inline(root) as Record<string, unknown>
}
