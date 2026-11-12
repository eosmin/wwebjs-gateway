import { Logger } from '@nestjs/common'
import type { Queue, Worker } from 'bullmq'

import { withTimeout } from '../../common/lib/timeout.js'

// With Redis unreachable a BullMQ close() waits for a connection that does not come back, and the
// shutdown would stay up until the hard exit. The graceful waits are for a Redis that answers.
export const REDIS_DOWN_CLOSE_MS = 1000
const QUEUE_CLOSE_MS = 5000
const logger = new Logger('BullmqClose')

const giveUp = (label: string) => (error: unknown) => {
  logger.warn(
    `${label} did not finish: ${error instanceof Error ? error.message : 'unknown error'}`
  )
}

// `client` is anything with the ioredis status; a stand-in without one counts as healthy
function isDown(client: { status?: string }): boolean {
  return client.status !== undefined && client.status !== 'ready'
}

// Waits for the job in hand to finish; one that is stuck falls back to the forced close. With Redis
// down there is nothing to finish gracefully, so it goes straight to the forced close. Both bounded.
export async function closeWorker(
  worker: Pick<Worker, 'close'>,
  client: { status?: string },
  gracefulMs: number,
  label: string
): Promise<void> {
  if (!isDown(client)) {
    try {
      await withTimeout(worker.close(), gracefulMs, label)
      return
    } catch {
      // stuck: forced below
    }
  }
  await withTimeout(worker.close(true), REDIS_DOWN_CLOSE_MS, `${label} (forced)`).catch(
    giveUp(`${label} (forced)`)
  )
}

export async function closeQueue(
  queue: Pick<Queue, 'close'>,
  client: { status?: string },
  label: string
): Promise<void> {
  await withTimeout(
    queue.close(),
    isDown(client) ? REDIS_DOWN_CLOSE_MS : QUEUE_CLOSE_MS,
    label
  ).catch(giveUp(label))
}
