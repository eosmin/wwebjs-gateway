import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'

import { AppModule } from './app.module.js'
import { APP_CONFIG } from './config/config.module.js'
import type { AppConfig } from './config/env.schema.js'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())
  app.enableShutdownHooks()
  const config = app.get<AppConfig>(APP_CONFIG)
  await app.listen(config.PORT, config.HOST)
}

void bootstrap()
