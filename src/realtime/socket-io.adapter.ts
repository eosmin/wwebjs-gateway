import type { INestApplicationContext } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import type { Server, ServerOptions } from 'socket.io'

import type { AppConfig } from '../config/env.schema.js'

// Largest packet a client may send: a command is JSON like a REST body, whose limit is 1 MiB too
const MAX_CLIENT_PACKET_BYTES = 1024 * 1024

// Messages of one event that one client may have handled at once; later ones wait their turn
const MAX_CONCURRENT_MESSAGES = 64

// The Socket.IO server of the gateway with the options that come from the environment, which a
// decorator cannot read. CORS follows CORS_ORIGINS exactly like the REST routes: no origin listed, no
// CORS headers (the browser same-origin policy applies).
export class GatewayIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: Pick<AppConfig, 'CORS_ORIGINS'>
  ) {
    super(app, { maxConcurrentMessages: MAX_CONCURRENT_MESSAGES })
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const own: Partial<ServerOptions> = {
      maxHttpBufferSize: MAX_CLIENT_PACKET_BYTES,
      ...(this.config.CORS_ORIGINS.length > 0 && { cors: { origin: this.config.CORS_ORIGINS } })
    }
    const merged = Object.assign({}, options, own)
    return super.createIOServer(port, merged)
  }
}
