import type { OpenAPIObject } from '@nestjs/swagger'

import { findExampleProblems, findOpenApiProblems, findSchemaDrift } from './openapi-check.js'

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

function documentWith(schemas: Record<string, unknown>, operation: Record<string, unknown> = {}) {
  return {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: { '/v1/things': { get: { operationId: 'things.list', ...operation } } },
    components: { schemas }
  } as unknown as OpenAPIObject // reason: a partial document, only what the check reads
}

describe('findSchemaDrift', () => {
  const declared = {
    type: 'object',
    properties: {
      name: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' } }
    }
  }

  it('accepts a document that says what the DTO declares', () => {
    expect(findSchemaDrift(declared, declared, documentWith({}))).toEqual([])
  })

  it('accepts a nullable written as an anyOf with null', () => {
    const documented = {
      type: 'object',
      properties: {
        name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string' } }
      }
    }

    expect(findSchemaDrift(declared, documented, documentWith({}))).toEqual([])
  })

  it('reports a nullable that became a list (nestjs-zod 5.5)', () => {
    const documented = {
      type: 'object',
      properties: {
        name: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } }
      }
    }

    expect(findSchemaDrift(declared, documented, documentWith({}))).toEqual([
      '$.name: the DTO accepts [null, string], the document [array]'
    ])
  })

  it('follows the references of both sides and the items of a list', () => {
    const zod = {
      type: 'array',
      items: { $ref: '#/$defs/Thing' },
      $defs: { Thing: { type: 'object', properties: { id: { type: ['string', 'null'] } } } }
    }
    const documented = { type: 'array', items: { $ref: '#/components/schemas/Thing' } }
    const wrong = { type: 'object', properties: { id: { type: 'string' } } }

    expect(findSchemaDrift(zod, documented, documentWith({ Thing: wrong }))).toEqual([
      '$[].id: the DTO accepts [null, string], the document [string]'
    ])
  })

  it('compares the branches of a union', () => {
    const zod = {
      anyOf: [
        { type: 'object', properties: { id: { type: ['string', 'null'] } } },
        { type: 'object', properties: { n: { type: 'number' } } }
      ]
    }
    const documented = {
      anyOf: [
        { type: 'object', properties: { id: { type: 'array', items: { type: 'string' } } } },
        { type: 'object', properties: { n: { type: 'number' } } }
      ]
    }

    expect(findSchemaDrift(zod, documented, documentWith({}))).toEqual([
      '$|0.id: the DTO accepts [null, string], the document [array]'
    ])
  })

  it('ends on a recursive schema', () => {
    const zod = {
      $ref: '#/$defs/Node',
      $defs: {
        Node: {
          type: 'object',
          properties: { next: { anyOf: [{ $ref: '#/$defs/Node' }, { type: 'null' }] } }
        }
      }
    }
    const node = {
      type: 'object',
      properties: {
        next: { anyOf: [{ $ref: '#/components/schemas/Node' }, { type: 'null' }] }
      }
    }

    expect(
      findSchemaDrift(zod, { $ref: '#/components/schemas/Node' }, documentWith({ Node: node }))
    ).toEqual([])
  })

  it('reports a property the document lacks', () => {
    expect(findSchemaDrift(declared, { type: 'object', properties: {} }, documentWith({}))).toEqual(
      ['$.name: is not in the document', '$.tags: is not in the document']
    )
  })
})

describe('findExampleProblems', () => {
  const responseOf = (schema: unknown) => ({
    responses: { '200': { description: '', content: { 'application/json': { schema } } } }
  })
  const thing = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }

  it('accepts an example that validates, through a reference', () => {
    const document = documentWith(
      { Thing: thing },
      responseOf({ $ref: '#/components/schemas/Thing' })
    )

    expect(
      findExampleProblems(document, [
        { id: 'things.list', examples: { request: null, response: { id: 'a' } } }
      ])
    ).toEqual([])
  })

  it('reports an example the schema rejects', () => {
    const document = documentWith(
      { Thing: thing },
      responseOf({ $ref: '#/components/schemas/Thing' })
    )

    expect(
      findExampleProblems(document, [
        { id: 'things.list', examples: { request: null, response: {} } }
      ])
    ).toEqual([
      "things.list: the response example does not validate (/ must have required property 'id')"
    ])
  })

  it('checks the request example against the request body', () => {
    const document = documentWith(
      {},
      {
        requestBody: { content: { 'application/json': { schema: thing } } },
        ...responseOf(thing)
      }
    )

    expect(
      findExampleProblems(document, [
        { id: 'things.list', examples: { request: {}, response: null } }
      ])
    ).toEqual([
      "things.list: the request example does not validate (/ must have required property 'id')"
    ])
  })
})
