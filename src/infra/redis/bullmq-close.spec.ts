import { closeQueue, closeWorker, REDIS_DOWN_CLOSE_MS } from './bullmq-close.js'

const never = (): Promise<void> => new Promise(() => undefined)

// What BullMQ 6 does with `close`: a second call, forced or not, gets the promise of the first
const bullmqLikeWorker = (jobInHand: Promise<void>) => {
  let closing: Promise<void> | undefined
  return {
    pause: jest.fn(() => jobInHand),
    close: jest.fn((force?: boolean) => {
      closing ??= force === true ? Promise.resolve() : jobInHand
      return closing
    })
  }
}

describe('closeWorker', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('waits the graceful time when Redis is ready, then really forces the close of a stuck job', async () => {
    const worker = bullmqLikeWorker(never())
    const done = closeWorker(worker, { status: 'ready' }, 15_000, 'worker')

    await jest.advanceTimersByTimeAsync(15_000 - 1)
    expect(worker.close).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)

    await expect(done).resolves.toBeUndefined()
    // The first close is the forced one: a `close()` before it would make it a no-op
    expect(worker.close).toHaveBeenCalledTimes(1)
    expect(worker.close).toHaveBeenCalledWith(true)
    await expect(worker.close.mock.results[0]?.value).resolves.toBeUndefined()
  })

  it('gives up after a couple of seconds when Redis is down, even if the forced close hangs', async () => {
    const worker = { pause: jest.fn(never), close: jest.fn(never) }
    const done = closeWorker(worker, { status: 'reconnecting' }, 15_000, 'worker')

    await jest.advanceTimersByTimeAsync(REDIS_DOWN_CLOSE_MS)

    await expect(done).resolves.toBeUndefined()
    expect(worker.pause).not.toHaveBeenCalled()
    expect(worker.close).toHaveBeenCalledTimes(1)
    expect(worker.close).toHaveBeenCalledWith(true)
  })
})

describe('closeWorker when the job in hand finishes in time', () => {
  it('waits for it, and only then closes', async () => {
    const order: string[] = []
    const worker = {
      pause: jest.fn(() => {
        order.push('pause')
        return Promise.resolve()
      }),
      close: jest.fn(() => {
        order.push('close')
        return Promise.resolve()
      })
    }

    await closeWorker(worker, { status: 'ready' }, 15_000, 'worker')

    expect(order).toEqual(['pause', 'close'])
  })
})

describe('closeQueue', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('does not wait for a queue that cannot close while Redis is down', async () => {
    const done = closeQueue({ close: never }, { status: 'reconnecting' }, 'queue')

    await jest.advanceTimersByTimeAsync(REDIS_DOWN_CLOSE_MS)

    await expect(done).resolves.toBeUndefined()
  })

  it('treats a client without a status as healthy', async () => {
    const close = jest.fn().mockResolvedValue(undefined)

    await expect(closeQueue({ close }, {}, 'queue')).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
