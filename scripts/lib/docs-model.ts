import 'reflect-metadata'

import { DiscoveryModule } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { OpenAPIObject } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'

import { buildOpenApiDocument } from '../../src/api/openapi.js'
import {
  OperationRegistryService,
  type RegisteredOperation
} from '../../src/api/operation-registry.service.js'
import { AppModule } from '../../src/app.module.js'
import { createFastifyAdapter } from '../../src/infra/logger/fastify-adapter.js'
import { collectControllers } from '../../src/parity/operation-links.js'

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const

export interface DocumentedOperation {
  registered: RegisteredOperation
  method: string
  path: string
}

export interface DocsModel {
  document: OpenAPIObject
  operations: readonly RegisteredOperation[]
  // The route each operation id has in the document; an id the document lacks is not here
  routes: ReadonlyMap<string, { method: string; path: string }>
}

// Method and path of every operation id the document declares
export function routesOf(document: OpenAPIObject): Map<string, { method: string; path: string }> {
  const routes = new Map<string, { method: string; path: string }>()
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const id = item[method]?.operationId
      if (id !== undefined) routes.set(id, { method: method.toUpperCase(), path })
    }
  }
  return routes
}

// The registry and the OpenAPI document of the real controllers, built the way the application builds
// them but over stand-ins for what the controllers inject: neither schema nor metadata needs a
// database, a queue or a WhatsApp client, so the documents can be generated (and checked in CI)
// without any of them.
let model: Promise<DocsModel> | undefined

async function build(): Promise<DocsModel> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: await collectControllers(AppModule),
    providers: [OperationRegistryService]
  })
    .useMocker(() => ({}))
    .compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
  app.useLogger(false)
  try {
    await app.init()
    const registry = app.get(OperationRegistryService)
    const document = buildOpenApiDocument(app, registry)
    return { document, operations: registry.list(), routes: routesOf(document) }
  } finally {
    await app.close()
  }
}

export function buildDocsModel(): Promise<DocsModel> {
  model ??= build()
  return model
}
