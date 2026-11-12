import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit
} from '@nestjs/common'
import type { Redis } from 'ioredis'

import { withTimeout } from '../../common/lib/timeout.js'
import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'

import { createRedisClient } from './redis.factory.js'

const QUIT_TIMEOUT_MS = 2000

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name)
  private readonly connections = new Set<Redis>()
  // The shared connection for ordinary commands
  readonly client: Redis

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = this.createConnection()
  }

  // ioredis retries for ever (BullMQ needs it), so without this bound a gateway whose Redis is
  // unreachable would sit silent instead of failing; the supervisor restarts a process that exits
  async onModuleInit(): Promise<void> {
    if (this.client.status === 'ready') return
    const timeoutMs = this.config.REDIS_CONNECT_TIMEOUT_MS
    const ready = new Promise<void>(resolve => {
      this.client.once('ready', () => resolve())
    })
    try {
      await withTimeout(ready, timeoutMs, 'redis connect')
    } catch {
      // Host and port only: the URL carries the password
      const { hostname, port } = new URL(this.config.REDIS_URL)
      throw new Error(
        `Redis is not reachable at ${hostname}:${port === '' ? '6379' : port} after ${timeoutMs} ms (REDIS_URL, REDIS_CONNECT_TIMEOUT_MS)`
      )
    }
  }

  // A separate connection, for the consumers that block (BullMQ workers) or subscribe
  createConnection(): Redis {
    const connection = createRedisClient(this.config.REDIS_URL, error => {
      this.logger.error(`Redis connection error: ${error.message}`)
    })
    this.connections.add(connection)
    return connection
  }

  // Runs after the queues and workers that use these connections have closed
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.connections].map(connection => this.close(connection)))
    this.connections.clear()
  }

  // quit() waits in the offline queue when Redis is down, so it is bounded; disconnect() then makes
  // sure the connection stops retrying and cannot keep the process alive
  private async close(connection: Redis): Promise<void> {
    try {
      await withTimeout(connection.quit(), QUIT_TIMEOUT_MS, 'redis quit')
    } catch {
      this.logger.warn('Redis did not quit cleanly, closing the connection')
    }
    connection.disconnect()
  }
}
