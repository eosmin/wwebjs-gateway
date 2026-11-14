import type { OpenAPIObject } from '@nestjs/swagger'

import { findOpenApiProblems } from './openapi-check.js'

const schema = { type: 'object' }
const withBody = { '200': { description: '', content: { 'application/json': { schema } } } }

function documentOf(operation: Record<string, unknown>): OpenAPIObject {
  return {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: { '/v1/things': { get: { operationId: 'things.list', ...operation } } }
  } as unknown as OpenAPIObject // reason: a partial document, only what the check reads
}

const listing = {
  id: 'things.list',
  scope: 'read' as const,
  examples: { request: null, response: [] }
}

describe('findOpenApiProblems', () => {
  it('accepts an operation with its scope and a success schema', () => {
    const document = documentOf({ 'x-scope': 'read', responses: withBody })

    expect(findOpenApiProblems(document, [listing])).toEqual([])
  })

  it('accepts an operation with no response body that answers 204', () => {
    const document = documentOf({ 'x-scope': 'read', responses: { '204': { description: '' } } })

    expect(
      findOpenApiProblems(document, [{ ...listing, examples: { request: null, response: null } }])
    ).toEqual([])
  })

  it('reports an operation the document does not have', () => {
    const document = documentOf({ 'x-scope': 'read', responses: withBody })

    expect(findOpenApiProblems(document, [{ ...listing, id: 'things.remove' }])).toEqual([
      'things.remove: is not in the OpenAPI document'
    ])
  })

  it('reports an operation without the scope of the registry', () => {
    expect(findOpenApiProblems(documentOf({ responses: withBody }), [listing])).toEqual([
      'things.list: scope is undefined in the document, read in the registry'
    ])
    expect(
      findOpenApiProblems(documentOf({ 'x-scope': 'admin', responses: withBody }), [listing])
    ).toEqual(['things.list: scope is "admin" in the document, read in the registry'])
  })

  it('reports an operation whose only response is a default or an error', () => {
    const noSuccess = {
      default: { description: '', content: { 'application/json': { schema } } },
      '404': { description: '', content: { 'application/json': { schema } } }
    }

    expect(
      findOpenApiProblems(documentOf({ 'x-scope': 'read', responses: noSuccess }), [listing])
    ).toEqual(['things.list: has no success response schema'])
  })

  it('reports a success without a schema when the operation is meant to have a body', () => {
    const empty = { '200': { description: '' } }

    expect(
      findOpenApiProblems(documentOf({ 'x-scope': 'read', responses: empty }), [listing])
    ).toEqual(['things.list: has no success response schema'])
  })

  it('does not take a 204 for an operation whose example has a body', () => {
    const document = documentOf({ 'x-scope': 'read', responses: { '204': { description: '' } } })

    expect(findOpenApiProblems(document, [listing])).toEqual([
      'things.list: has no success response schema'
    ])
  })
})
