import { closeQueue, closeWorker, REDIS_DOWN_CLOSE_MS } from './bullmq-close.js'

// The timers are fake, but a loaded machine can still starve the test of its 5 s
jest.setTimeout(30_000)

const never = (): Promise<void> => new Promise(() => undefined)

describe('closeWorker', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('waits the graceful time when Redis is ready, then forces the close', async () => {
    const close = jest
      .fn<Promise<void>, [boolean?]>()
      .mockImplementation(force => (force ? Promise.resolve() : never()))
    const done = closeWorker({ close }, { status: 'ready' }, 15_000, 'worker')

    await jest.advanceTimersByTimeAsync(15_000 - 1)
    expect(close).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)

    await expect(done).resolves.toBeUndefined()
    expect(close).toHaveBeenLastCalledWith(true)
  })

  it('gives up after a couple of seconds when Redis is down, even if the forced close hangs', async () => {
    const close = jest.fn<Promise<void>, [boolean?]>().mockImplementation(never)
    const done = closeWorker({ close }, { status: 'reconnecting' }, 15_000, 'worker')

    await jest.advanceTimersByTimeAsync(REDIS_DOWN_CLOSE_MS)

    await expect(done).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(true)
  })
})

describe('closeWorker when the graceful close works', () => {
  it('does not force it', async () => {
    const close = jest.fn().mockResolvedValue(undefined)

    await closeWorker({ close }, { status: 'ready' }, 15_000, 'worker')

    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith()
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
