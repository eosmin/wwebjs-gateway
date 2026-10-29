import { abortableSleep } from './abortable-sleep.js'

describe('abortableSleep', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('resolves true once the time has passed', async () => {
    const pending = abortableSleep(1000, new AbortController().signal)
    await jest.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe(true)
  })

  it('resolves false at once when the signal aborts during the wait', async () => {
    const controller = new AbortController()
    const pending = abortableSleep(60_000, controller.signal)
    controller.abort()
    await expect(pending).resolves.toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('resolves false without waiting when the signal is already aborted', async () => {
    await expect(abortableSleep(60_000, AbortSignal.abort())).resolves.toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not fire at once for a wait longer than a timer can hold', async () => {
    const controller = new AbortController()
    const pending = abortableSleep(3_000_000_000, controller.signal)
    await jest.advanceTimersByTimeAsync(1000)
    controller.abort()

    await expect(pending).resolves.toBe(false)
  })
})
