import helmet from '@fastify/helmet'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import type { AppConfig } from '../../config/env.schema.js'
import { REQUEST_ID_HEADER } from '../logger/logger.config.js'

// What Swagger UI needs from the content security policy; the policy is not relaxed when the docs are off
const DOCS_CSP = {
  directives: {
    defaultSrc: [`'self'`],
    styleSrc: [`'self'`, `'unsafe-inline'`],
    imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
    scriptSrc: [`'self'`, 'https:', `'unsafe-inline'`]
  }
}

// Security headers and CORS. Called by main.ts before the application listens.
export async function setupHttp(
  app: NestFastifyApplication,
  config: Pick<AppConfig, 'CORS_ORIGINS' | 'ENABLE_DOCS'>
): Promise<void> {
  await app.register(helmet, config.ENABLE_DOCS ? { contentSecurityPolicy: DOCS_CSP } : {})
  // No origin listed: the browser same-origin policy applies, which is what a server-to-server API wants
  if (config.CORS_ORIGINS.length > 0) {
    app.enableCors({
      origin: config.CORS_ORIGINS,
      exposedHeaders: [REQUEST_ID_HEADER, 'retry-after']
    })
  }
}
