import { z } from 'zod'

import { HTTP_METHODS, buildDocsModel, type DocsModel } from '../../scripts/lib/docs-model.js'
import {
  findExampleProblems,
  findOpenApiProblems,
  findSchemaDrift
} from '../../scripts/lib/openapi-check.js'
import { isSuccess } from '../../src/api/openapi.js'
import { AppModule } from '../../src/app.module.js'
import { collectOperations } from '../../src/parity/operation-links.js'

// the key @nestjs/swagger stores @ApiResponse under (DECORATORS.API_RESPONSE, not exported)
const API_RESPONSE_KEY = 'swagger/apiResponse'

let model: DocsModel

type Operation = NonNullable<DocsModel['document']['paths'][string]['get']>

function operationOf(
  document: DocsModel['document'],
  { method, path }: { method: string; path: string }
): Operation | undefined {
  const item = document.paths[path] as Record<string, Operation | undefined> | undefined
  return item?.[method.toLowerCase()]
}

// the status the route answers: the one 2xx the document lists
function successOf(operation: Operation): string {
  return Object.keys(operation.responses).find(isSuccess) ?? 'default'
}

beforeAll(async () => {
  model = await buildDocsModel()
}, 60_000)

// TDD §6.13: every operation of the registry is in the OpenAPI document, with its scope and a
// success response schema
describe('OpenAPI completeness', () => {
  it('has every @WaOperation of the controllers in the registry the document is built from', async () => {
    const declared = (await collectOperations(AppModule)).map(operation => operation.id).sort()

    expect(model.operations.map(({ meta }) => meta.id).sort()).toEqual(declared)
  })

  it('documents every operation with its scope and a success response schema', () => {
    expect(
      findOpenApiProblems(
        model.document,
        model.operations.map(({ meta }) => meta)
      )
    ).toEqual([])
  })

  it('lists every operation of the registry under its id', () => {
    const documented = new Set(model.routes.keys())

    expect(model.operations.map(({ meta }) => meta.id).filter(id => !documented.has(id))).toEqual(
      []
    )
  })

  // DP-1: nestjs-zod 5.5 let @nestjs/swagger read `type: ['string', 'null']` as a list of strings, so
  // every nullable field of a response was documented as an array
  it('documents every response the way its DTO declares it, nullable fields included', () => {
    const problems: string[] = []
    let compared = 0
    for (const { meta, controller, methodName } of model.operations) {
      const handler: unknown = Reflect.get(Object.getPrototypeOf(controller) as object, methodName)
      const responses: unknown =
        typeof handler === 'function' ? Reflect.getMetadata(API_RESPONSE_KEY, handler) : undefined
      const route = model.routes.get(meta.id)
      const operation = route && operationOf(model.document, route)
      if (typeof responses !== 'object' || responses === null || operation === undefined) continue
      for (const [status, response] of Object.entries(responses)) {
        const dto: unknown = (response as { type?: unknown }).type
        const schema = (dto as { schema?: z.ZodType } | undefined)?.schema
        if (schema === undefined || !('_zod' in schema)) continue
        const documented = operation.responses[status === 'default' ? successOf(operation) : status]
        const media =
          documented && 'content' in documented
            ? documented.content?.['application/json']
            : undefined
        if (media?.schema === undefined) continue
        compared += 1
        const declared = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>
        for (const problem of findSchemaDrift(
          declared,
          media.schema as Record<string, unknown>,
          model.document
        )) {
          problems.push(`${meta.id} ${status}: ${problem}`)
        }
      }
    }
    expect(problems).toEqual([])
    // the check must not pass because it compared nothing (a key of a library that moved)
    expect(compared).toBeGreaterThan(100)
  })

  it('has examples that validate against the schemas of the document', () => {
    expect(
      findExampleProblems(
        model.document,
        model.operations.map(({ meta }) => meta)
      )
    ).toEqual([])
  })

  // DP-2: the global rate limit answers every route, the public ones too
  it('documents the 429 RATE_LIMITED, with its Retry-After header, on every operation', () => {
    const problems: string[] = []
    for (const [path, item] of Object.entries(model.document.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = (item as Record<string, Operation | undefined>)[method]
        if (operation === undefined) continue
        const label = `${method.toUpperCase()} ${path}`
        const response = operation.responses['429']
        if (response === undefined || '$ref' in response) {
          problems.push(`${label}: has no 429`)
          continue
        }
        if (!response.description?.includes('RATE_LIMITED')) {
          problems.push(`${label}: the 429 does not describe RATE_LIMITED`)
        }
        if (response.headers?.['Retry-After'] === undefined) {
          problems.push(`${label}: the 429 has no Retry-After header`)
        }
        const schema = response.content?.['application/json']?.schema
        if (JSON.stringify(schema) !== '{"$ref":"#/components/schemas/ErrorBody"}') {
          problems.push(`${label}: the 429 body is not the ErrorBody`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('lists RATE_LIMITED once on an operation that already declares it', () => {
    const route = model.routes.get('webhooks.test')
    const response = route && operationOf(model.document, route)?.responses['429']
    const description = response && 'description' in response ? response.description : ''

    expect(description.match(/RATE_LIMITED/g)).toHaveLength(1)
  })

  it('names every response DTO, so no two share a component', () => {
    const names = Object.keys(model.document.components?.schemas ?? {})

    expect(names).not.toContain('AugmentedZodDto_Output')
    expect(names).toEqual(
      expect.arrayContaining([
        'ChannelResponseDto_Output',
        'ChatResponseDto_Output',
        'ContactResponseDto_Output',
        'GroupResponseDto_Output'
      ])
    )
  })
})
