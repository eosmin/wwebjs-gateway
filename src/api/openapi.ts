import type { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger'
import { cleanupOpenApiDoc } from 'nestjs-zod'

import { ERROR_DEFINITIONS, ErrorCode } from '../common/errors.js'
import type { AppConfig } from '../config/env.schema.js'

import { OperationRegistryService, type RegisteredOperation } from './operation-registry.service.js'

export const DOCS_PATH = 'docs'
export const DOCS_JSON_PATH = 'docs/json'
export const API_KEY_HEADER = 'x-api-key'
const ERROR_SCHEMA = 'ErrorBody'
const JSON_MEDIA = 'application/json'
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const

type ComponentSchema = NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string]
type Operation = NonNullable<OpenAPIObject['paths'][string]['get']>

const ERROR_BODY_SCHEMA: ComponentSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string', enum: Object.values(ErrorCode) },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string', description: 'Also sent in the x-request-id header.' }
      }
    }
  }
}

function isSuccess(status: string): boolean {
  return /^2\d\d$/.test(status)
}

// The codes an operation can answer, grouped under the HTTP status each one maps to
interface ErrorResponse {
  description: string
  content: Record<string, { schema: { $ref: string } }>
}

function errorResponses(codes: readonly ErrorCode[]): Record<string, ErrorResponse> {
  const byStatus = new Map<number, ErrorCode[]>()
  for (const code of codes) {
    const status = ERROR_DEFINITIONS[code].status
    byStatus.set(status, [...(byStatus.get(status) ?? []), code])
  }
  return Object.fromEntries(
    [...byStatus].map(([status, group]) => [
      String(status),
      {
        description: group
          .map(code => `**${code}**: ${ERROR_DEFINITIONS[code].meaning}`)
          .join('\n\n'),
        content: { [JSON_MEDIA]: { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA}` } } }
      }
    ])
  )
}

// Copies what @WaOperation declares into the matching OpenAPI operation, so the document and the
// registry (socket commands, parity, generated docs) cannot say different things
function enrich(operation: Operation, { meta }: RegisteredOperation): void {
  operation.summary = meta.summary
  operation.description = meta.description
  Object.assign(operation, {
    'x-scope': meta.scope,
    'x-wwebjs': meta.wwebjs,
    ...(meta.gateway === true && { 'x-gateway': true }),
    ...(meta.socket && { 'x-socket-command': meta.socket.command })
  })

  const requestBody = operation.requestBody
  if (requestBody && 'content' in requestBody && meta.examples.request !== null) {
    const media = (requestBody.content[JSON_MEDIA] ??= {})
    media.example = meta.examples.request
  }

  const success = Object.keys(operation.responses).find(isSuccess)
  // `null` is an operation with no response body (204, ...): nothing to exemplify
  if (success !== undefined && meta.examples.response !== null) {
    const response = operation.responses[success]
    if (response && !('$ref' in response)) {
      const content = (response.content ??= {})
      const media = (content[JSON_MEDIA] ??= {})
      media.example = meta.examples.response
    }
  }

  // The declared errors win over any 4xx/5xx Nest generated, so an operation lists the codes it can answer
  Object.assign(operation.responses, errorResponses(meta.errors))
}

export function buildOpenApiDocument(
  app: INestApplication,
  registry: OperationRegistryService
): OpenAPIObject {
  const operations = new Map(registry.list().map(op => [op.meta.id, op]))
  const idByHandler = new Map(
    registry.list().map(op => [`${op.controller.constructor.name}.${op.methodName}`, op.meta.id])
  )
  const config = new DocumentBuilder()
    .setTitle('wwebjs-gateway')
    .setDescription('REST, webhooks and Socket.IO gateway over whatsapp-web.js')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: API_KEY_HEADER }, 'apiKey')
    .addSecurityRequirements('apiKey')
    .build()

  const document = cleanupOpenApiDoc(
    SwaggerModule.createDocument(app, config, {
      // The id of the registry is the operationId, so a client generated from the document keeps it
      operationIdFactory: (controllerKey, methodKey) =>
        idByHandler.get(`${controllerKey}.${methodKey}`) ?? `${controllerKey}.${methodKey}`
    })
  )

  document.components ??= {}
  document.components.schemas = {
    ...document.components.schemas,
    [ERROR_SCHEMA]: ERROR_BODY_SCHEMA
  }
  for (const pathItem of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      const registered = operation?.operationId ? operations.get(operation.operationId) : undefined
      if (operation && registered) enrich(operation, registered)
    }
  }
  return document
}

// Swagger UI at /docs and the raw document at /docs/json (public, so only mounted when ENABLE_DOCS is true)
export function setupDocs(app: INestApplication, config: Pick<AppConfig, 'ENABLE_DOCS'>): void {
  if (!config.ENABLE_DOCS) return
  // A factory, so the document is built on the first request: the registry scans the controllers on
  // module init, which has not run yet when main.ts calls this before listen()
  const document = (): OpenAPIObject => buildOpenApiDocument(app, app.get(OperationRegistryService))
  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: DOCS_JSON_PATH,
    raw: ['json'],
    customSiteTitle: 'wwebjs-gateway'
  })
}
