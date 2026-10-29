import { KeyedLock } from './keyed-lock.js'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('KeyedLock', () => {
  it('runs the tasks of one key in the order they were asked, never together', async () => {
    const lock = new KeyedLock()
    const log: string[] = []
    const gate = deferred()

    const first = lock.run('a', async () => {
      log.push('first start')
      await gate.promise
      log.push('first end')
    })
    const second = lock.run('a', () => {
      log.push('second')
      return Promise.resolve()
    })

    await Promise.resolve()
    expect(log).toEqual(['first start'])
    gate.resolve()
    await Promise.all([first, second])

    expect(log).toEqual(['first start', 'first end', 'second'])
  })

  it('lets different keys run at the same time', async () => {
    const lock = new KeyedLock()
    const gate = deferred()
    const log: string[] = []

    void lock.run('a', async () => {
      await gate.promise
    })
    await lock.run('b', () => {
      log.push('b ran')
      return Promise.resolve()
    })

    expect(log).toEqual(['b ran'])
    gate.resolve()
  })

  it('returns what the task returns and passes its failure on', async () => {
    const lock = new KeyedLock()

    expect(await lock.run('a', () => Promise.resolve(42))).toBe(42)
    await expect(lock.run('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })

  it('keeps running the queue after a task failed', async () => {
    const lock = new KeyedLock()
    const failing = lock.run('a', () => Promise.reject(new Error('boom')))
    const next = lock.run('a', () => Promise.resolve('ran'))

    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('ran')
  })
})
