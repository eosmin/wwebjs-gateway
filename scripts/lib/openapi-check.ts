import type { OpenAPIObject } from '@nestjs/swagger'
import { Ajv2020 } from 'ajv/dist/2020.js'

import { isSuccess } from '../../src/api/openapi.js'
import type { WaOperationMeta } from '../../src/api/wa-operation.schema.js'

import { HTTP_METHODS, routesOf } from './docs-model.js'

type Operation = Record<string, unknown> & {
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>
}

// What TDD §6.13 asks of the OpenAPI document for every operation of the registry: it is in the
// document, under its id, with its scope, and it says what a success looks like (a schema, or a 204
// for an operation with no response body). One line per problem, none when the document is complete.
export function findOpenApiProblems(
  document: OpenAPIObject,
  operations: readonly Pick<WaOperationMeta, 'id' | 'scope' | 'examples'>[]
): string[] {
  const routes = routesOf(document)
  const problems: string[] = []

  for (const { id, scope, examples } of operations) {
    const route = routes.get(id)
    if (route === undefined) {
      problems.push(`${id}: is not in the OpenAPI document`)
      continue
    }
    const item = document.paths[route.path] as Record<string, unknown> | undefined
    const method = HTTP_METHODS.find(candidate => candidate.toUpperCase() === route.method)
    const operation = (method === undefined ? undefined : item?.[method]) as Operation | undefined
    if (operation === undefined) {
      problems.push(`${id}: is not in the OpenAPI document`)
      continue
    }

    if (operation['x-scope'] !== scope) {
      problems.push(
        `${id}: scope is ${JSON.stringify(operation['x-scope'])} in the document, ${scope} in the registry`
      )
    }

    const successes = Object.entries(operation.responses ?? {}).filter(([status]) =>
      isSuccess(status)
    )
    const hasSchema = successes.some(([, response]) =>
      Object.values(response.content ?? {}).some(media => media.schema !== undefined)
    )
    const hasNoBody = examples.response === null && successes.some(([status]) => status === '204')
    if (!hasSchema && !hasNoBody) problems.push(`${id}: has no success response schema`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// The schemas of the document against the schemas the DTOs declare, and the examples of the registry
// against the schemas of the document.
// ---------------------------------------------------------------------------------------------

type Schema = Record<string, unknown>

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function resolve(schema: Schema, pool: Schema, prefix: string): Schema {
  const ref = schema['$ref']
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) return schema
  const target = pool[ref.slice(prefix.length)]
  return isSchema(target) ? target : schema
}

// The JSON types a schema accepts at its own level: `type` (a name or a list) and the branches of an
// `anyOf` (what zod writes for a union and for a nullable of a non-primitive). A reference is followed
// once, so a recursive schema ends.
function acceptedTypes(
  schema: Schema,
  resolveRef: (schema: Schema) => Schema,
  followed: Set<Schema> = new Set()
): string[] {
  const own = resolveRef(schema)
  if (followed.has(own)) return []
  followed.add(own)
  const types = new Set<string>()
  const { type, anyOf } = own
  if (typeof type === 'string' && type !== '') types.add(type)
  if (Array.isArray(type)) for (const name of type) if (typeof name === 'string') types.add(name)
  if (Array.isArray(anyOf)) {
    for (const branch of anyOf) {
      if (!isSchema(branch)) continue
      for (const name of acceptedTypes(branch, resolveRef, followed)) types.add(name)
    }
  }
  return [...types].sort()
}

// What a generated schema must keep of the zod schema the DTO declares: what each property, item and
// branch accepts (a nullable string stays a string or null, it does not become a list of strings).
// One line per difference, none when the document says what the DTO declares.
export function findSchemaDrift(
  declared: Schema,
  documented: Schema,
  document: OpenAPIObject
): string[] {
  const { $defs, ...root } = declared
  const defs = isSchema($defs) ? $defs : {}
  const components: Schema = document.components?.schemas ?? {}
  const problems: string[] = []
  const seen = new Set<string>()

  const walk = (zod: Schema, doc: Schema, path: string): void => {
    const zodSchema = resolve(zod, defs, '#/$defs/')
    const docSchema = resolve(doc, components, '#/components/schemas/')
    // a pair of references is compared once, wherever it appears: a recursive DTO ends here
    if (typeof zod['$ref'] === 'string' && typeof doc['$ref'] === 'string') {
      const key = `${zod['$ref']}|${doc['$ref']}`
      if (seen.has(key)) return
      seen.add(key)
    }

    const expected = acceptedTypes(zodSchema, schema => resolve(schema, defs, '#/$defs/'))
    const actual = acceptedTypes(docSchema, schema =>
      resolve(schema, components, '#/components/schemas/')
    )
    // a recursive z.json() has no fixed type: nothing to compare
    if (expected.length > 0 && expected.join() !== actual.join()) {
      problems.push(
        `${path}: the DTO accepts [${expected.join(', ')}], the document [${actual.join(', ')}]`
      )
      return
    }
    const zodProperties = zodSchema['properties']
    const docProperties = docSchema['properties']
    if (isSchema(zodProperties) && isSchema(docProperties)) {
      for (const [name, property] of Object.entries(zodProperties)) {
        const counterpart = docProperties[name]
        if (!isSchema(property)) continue
        if (!isSchema(counterpart)) problems.push(`${path}.${name}: is not in the document`)
        else walk(property, counterpart, `${path}.${name}`)
      }
    }
    // the branches of a union, in the order zod writes them
    const zodBranches = zodSchema['anyOf']
    const docBranches = docSchema['anyOf']
    if (
      Array.isArray(zodBranches) &&
      Array.isArray(docBranches) &&
      zodBranches.length === docBranches.length
    ) {
      zodBranches.forEach((branch: unknown, index: number) => {
        const counterpart: unknown = docBranches[index]
        if (isSchema(branch) && isSchema(counterpart)) walk(branch, counterpart, `${path}|${index}`)
      })
    }
    if (isSchema(zodSchema['items']) && isSchema(docSchema['items'])) {
      walk(zodSchema['items'], docSchema['items'], `${path}[]`)
    }
  }

  walk(root, documented, '$')
  return problems
}

// The examples the registry declares, checked against the schemas of the document: a client generated
// from the document would reject a response the gateway really sends when the schema is wrong, and a
// documentation example that does not validate teaches a wrong call.
export function findExampleProblems(
  document: OpenAPIObject,
  operations: readonly Pick<WaOperationMeta, 'id' | 'examples'>[]
): string[] {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true })
  const routes = routesOf(document)
  const problems: string[] = []

  const check = (id: string, label: string, schema: unknown, example: unknown): void => {
    if (!isSchema(schema)) return
    // the refs of the document (`#/components/schemas/X`) resolve against the root of the schema
    const validate = ajv.compile({ ...schema, components: document.components })
    if (validate(example)) return
    const errors = (validate.errors ?? []).map(
      error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
    )
    problems.push(`${id}: the ${label} example does not validate (${errors.join('; ')})`)
  }

  for (const { id, examples } of operations) {
    const route = routes.get(id)
    const method = HTTP_METHODS.find(candidate => candidate.toUpperCase() === route?.method)
    const item = route === undefined ? undefined : document.paths[route.path]
    const operation = (method === undefined ? undefined : item?.[method]) as Operation | undefined
    if (operation === undefined) continue

    const body = (operation as { requestBody?: { content?: Record<string, { schema?: unknown }> } })
      .requestBody
    if (examples.request !== null) {
      check(id, 'request', body?.content?.['application/json']?.schema, examples.request)
    }
    const success = Object.entries(operation.responses ?? {}).find(([status]) => isSuccess(status))
    if (examples.response !== null && success !== undefined) {
      check(id, 'response', success[1].content?.['application/json']?.schema, examples.response)
    }
  }
  return problems
}
