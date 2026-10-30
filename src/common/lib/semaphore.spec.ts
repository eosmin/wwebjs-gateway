import { Semaphore } from './semaphore.js'

const gate = () => {
  let open: () => void = () => undefined
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

describe('Semaphore', () => {
  it('runs at most `permits` tasks at once and starts the next as one ends', async () => {
    const semaphore = new Semaphore(2)
    const gates = [gate(), gate(), gate()]
    const started: number[] = []
    const tasks = gates.map((g, index) =>
      semaphore.run(async () => {
        started.push(index)
        await g.opened
      })
    )

    await Promise.resolve()
    expect(started).toEqual([0, 1])

    gates[0]?.open()
    await new Promise(resolve => setImmediate(resolve))
    expect(started).toEqual([0, 1, 2])

    gates[1]?.open()
    gates[2]?.open()
    await Promise.all(tasks)
  })

  it('gives the permit back when a task fails', async () => {
    const semaphore = new Semaphore(1)

    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(semaphore.run(() => Promise.resolve('next'))).resolves.toBe('next')
  })
})
