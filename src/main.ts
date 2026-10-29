import { NestFactory } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { setupDocs } from './api/openapi.js'
import { AppModule } from './app.module.js'
import { APP_CONFIG } from './config/config.module.js'
import type { AppConfig } from './config/env.schema.js'
import { setupHttp } from './infra/http/http-setup.js'
import { createFastifyAdapter } from './infra/logger/fastify-adapter.js'
import { armHardExit } from './infra/process/hard-exit.js'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    bufferLogs: true
  })
  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()
  armHardExit()
  const config = app.get<AppConfig>(APP_CONFIG)
  await setupHttp(app, config)
  setupDocs(app, config)
  await app.listen(config.PORT, config.HOST)
}

void bootstrap()
