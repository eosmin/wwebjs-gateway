import { Redis } from 'ioredis'

// BullMQ workers need `maxRetriesPerRequest: null` (commands wait for the connection instead of
// failing after 20 retries), so every connection of the gateway is created with it
export function createRedisClient(url: string, onError: (error: Error) => void): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: null })
  // Without a listener ioredis prints the error with console.error and the log loses its context
  client.on('error', onError)
  return client
}
