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
import { envSchema } from '../../src/config/env.schema.js'
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

// ConfigModule validates the environment while AppModule loads. The documents do not depend on any
// value, so the smallest valid environment is set (and what a shell or a .env.local holds is left
// out), which makes the generation the same on every machine and in CI.
const DOCS_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_API_KEY: 'a'.repeat(32)
}

async function build(): Promise<DocsModel> {
  for (const key of Object.keys(envSchema.shape)) delete process.env[key]
  Object.assign(process.env, DOCS_ENV)
  // After the environment is set: a static import would load the module first
  const { AppModule } = await import('../../src/app.module.js')
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
