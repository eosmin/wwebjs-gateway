import type { Redis } from 'ioredis'

import { createRedisClient } from './redis.factory.js'

// Nothing listens on port 1: the connection fails, which is what these specs need
const UNREACHABLE = 'redis://127.0.0.1:1'

describe('createRedisClient', () => {
  const clients: Redis[] = []

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect()
  })

  it('lets commands wait for the connection, as BullMQ workers require', () => {
    const client = createRedisClient(UNREACHABLE, () => undefined)
    clients.push(client)

    expect(client.options.maxRetriesPerRequest).toBeNull()
  })

  it('reports connection errors to the given handler', async () => {
    const error = await new Promise<Error>(resolve => {
      clients.push(createRedisClient(UNREACHABLE, resolve))
    })

    // Not toBeInstanceOf: ioredis creates the error outside Jest's module realm
    expect(typeof error.message).toBe('string')
  })
})
