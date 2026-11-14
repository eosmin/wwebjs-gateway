import type { OpenAPIObject } from '@nestjs/swagger'

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
