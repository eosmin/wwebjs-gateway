import { NestFactory } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { mergeQueueSources, setupBullBoard } from './api/bull-board.js'
import { setupDocs } from './api/openapi.js'
import { AppModule } from './app.module.js'
import { APP_CONFIG } from './config/config.module.js'
import type { AppConfig } from './config/env.schema.js'
import { applyServerTimeouts, setupHttp } from './infra/http/http-setup.js'
import { createFastifyAdapter } from './infra/logger/fastify-adapter.js'
import { armHardExit } from './infra/process/hard-exit.js'
import { DeliveryQueueService } from './services/delivery-queue.service.js'
import { SendQueueService } from './services/send-queue.service.js'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    bufferLogs: true,
    // The error reaches the catch below instead of aborting the process without a message
    abortOnError: false
  })
  app.useLogger(app.get(Logger))
  // process.exit after the hooks instead of re-sending the signal to itself: the re-sent signal
  // left the process alive until the hard exit when Redis was down (measured: 30 s)
  app.enableShutdownHooks(undefined, { useProcessExit: true })
  armHardExit()
  const config = app.get<AppConfig>(APP_CONFIG)
  await setupHttp(app, config)
  applyServerTimeouts(app.getHttpServer(), config)
  setupDocs(app, config)
  await setupBullBoard(
    app,
    config,
    mergeQueueSources(app.get(SendQueueService), app.get(DeliveryQueueService))
  )
  await app.listen(config.PORT, config.HOST)
}

// A failure while the application starts (Redis or Postgres unreachable, an invalid environment)
// must end the process with the reason on stderr and a non-zero code, not leave it half started
bootstrap().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: `Startup failed: ${reason}` })}\n`)
  process.exit(1)
})
