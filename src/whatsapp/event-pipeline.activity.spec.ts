import { Logger } from '@nestjs/common'

import { ACTIVITY_WRITE_INTERVAL_MS, ActivityRecorder } from './event-pipeline.activity.js'

const SESSION = 'support-line'
const START = new Date('2026-10-28T12:00:00.000Z')

function build() {
  const save = jest.fn((_sessionId: string, _at: Date) => Promise.resolve())
  return { recorder: new ActivityRecorder({ save }), save }
}

let warnLog: jest.SpyInstance

beforeEach(() => {
  jest.useFakeTimers({ now: START })
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('ActivityRecorder', () => {
  it('writes the first activity at once', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, Date.now())
    await jest.advanceTimersByTimeAsync(0)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(SESSION, START)
  })

  it('writes a burst once per interval, with the latest time', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, Date.now())
    await jest.advanceTimersByTimeAsync(10_000)
    recorder.note(SESSION, Date.now())
    await jest.advanceTimersByTimeAsync(10_000)
    recorder.note(SESSION, Date.now())
    expect(save).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS)

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(SESSION, new Date(START.getTime() + 20_000))
  })

  it('writes nothing when there is no new activity', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, Date.now())
    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS * 3)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flushes what is pending when the session stops, and only once', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, Date.now())
    await jest.advanceTimersByTimeAsync(5000)
    recorder.note(SESSION, Date.now())

    await recorder.flush(SESSION)
    await recorder.flush(SESSION)
    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS)

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(SESSION, new Date(START.getTime() + 5000))
  })

  it('keeps a failed write and tries again later without rejecting', async () => {
    const { recorder, save } = build()
    save.mockRejectedValueOnce(new Error('db down'))
    recorder.note(SESSION, Date.now())
    await jest.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS)

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(SESSION, START)
  })

  it('does not let a failed flush reject, and logs it', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, START.getTime() - 1000)
    await jest.advanceTimersByTimeAsync(0)
    recorder.note(SESSION, START.getTime())
    save.mockRejectedValueOnce(new Error('db down'))

    await expect(recorder.flush(SESSION)).resolves.toBeUndefined()

    expect(save).toHaveBeenCalledTimes(2)
    expect(warnLog).toHaveBeenCalledTimes(1)
  })

  it('writes nothing for a session that was forgotten', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, Date.now())
    await jest.advanceTimersByTimeAsync(1000)
    recorder.note(SESSION, Date.now())
    recorder.forget(SESSION)
    await recorder.flush(SESSION)
    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps one clock per session', async () => {
    const { recorder, save } = build()
    recorder.note('a', Date.now())
    recorder.note('b', Date.now())
    await jest.advanceTimersByTimeAsync(0)

    expect(save).toHaveBeenCalledTimes(2)
  })

  it('records the time given, never going back or past the present', async () => {
    const { recorder, save } = build()
    const before = START.getTime() - 3_600_000
    recorder.note(SESSION, before)
    await jest.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenLastCalledWith(SESSION, new Date(before))

    // A message older than what is recorded (a backlog) does not pull it back
    recorder.note(SESSION, before - 1000)
    await recorder.flush(SESSION)
    expect(save).toHaveBeenCalledTimes(1)

    // A sender clock ahead of ours is capped at now
    recorder.note(SESSION, START.getTime() + 86_400_000)
    await recorder.flush(SESSION)
    expect(save).toHaveBeenLastCalledWith(SESSION, START)
  })

  it('waits for a write in flight on flush, and writes in order', async () => {
    const { recorder, save } = build()
    const order: string[] = []
    let finishFirst: () => void = () => undefined
    save.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishFirst = () => {
            order.push('first done')
            resolve()
          }
        })
    )
    save.mockImplementationOnce(() => {
      order.push('second')
      return Promise.resolve()
    })
    recorder.note(SESSION, START.getTime() - 5000)
    await jest.advanceTimersByTimeAsync(0)
    recorder.note(SESSION, START.getTime())

    let flushed = false
    const flushing = recorder.flush(SESSION).then(() => {
      flushed = true
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(flushed).toBe(false)

    finishFirst()
    await flushing

    expect(order).toEqual(['first done', 'second'])
  })

  it('does not schedule a retry when the final flush fails', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, START.getTime() - 1000)
    await jest.advanceTimersByTimeAsync(0)
    recorder.note(SESSION, START.getTime())
    save.mockRejectedValueOnce(new Error('db down'))

    await recorder.flush(SESSION)
    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS * 2)

    expect(save).toHaveBeenCalledTimes(2)
  })

  it('keeps the newer activity when the write in flight fails', async () => {
    const { recorder, save } = build()
    let rejectFirst: () => void = () => undefined
    save.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = () => reject(new Error('db down'))
        })
    )
    recorder.note(SESSION, START.getTime() - 2000)
    await jest.advanceTimersByTimeAsync(0)
    recorder.note(SESSION, START.getTime())
    rejectFirst()
    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS)

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(SESSION, START)
  })

  it('does not retry for a session forgotten while its write was failing', async () => {
    const { recorder, save } = build()
    let rejectFirst: () => void = () => undefined
    save.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = () => reject(new Error('db down'))
        })
    )
    recorder.note(SESSION, START.getTime())
    await jest.advanceTimersByTimeAsync(0)
    recorder.forget(SESSION)
    rejectFirst()
    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS * 2)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('retries again when a scheduled write fails', async () => {
    const { recorder, save } = build()
    recorder.note(SESSION, START.getTime() - 1000)
    await jest.advanceTimersByTimeAsync(0)
    recorder.note(SESSION, START.getTime())
    save.mockRejectedValueOnce(new Error('db down'))

    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS)
    expect(save).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS)

    expect(save).toHaveBeenCalledTimes(3)
    expect(save).toHaveBeenLastCalledWith(SESSION, START)
  })
})
