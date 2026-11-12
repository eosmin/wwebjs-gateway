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

  it('keeps the order of arrival for the tasks of one owner', async () => {
    const semaphore = new Semaphore(1)
    const first = gate()
    const started: string[] = []
    const run = (name: string, g?: ReturnType<typeof gate>) =>
      semaphore.run(async () => {
        started.push(name)
        await g?.opened
      }, 'a')
    const tasks = [run('a1', first), run('a2'), run('a3')]
    first.open()
    await Promise.all(tasks)
    expect(started).toEqual(['a1', 'a2', 'a3'])
  })

  it('gives the next permit to the owner that has waited longest, so a busy owner cannot starve another', async () => {
    const semaphore = new Semaphore(1)
    const blocker = gate()
    const started: string[] = []
    const run = (owner: string, name: string, g?: ReturnType<typeof gate>) =>
      semaphore.run(async () => {
        started.push(name)
        await g?.opened
      }, owner)
    // `busy` holds the permit and has three more waiting; `quiet` arrives last with one
    const tasks = [
      run('busy', 'busy1', blocker),
      run('busy', 'busy2'),
      run('busy', 'busy3'),
      run('busy', 'busy4'),
      run('quiet', 'quiet1')
    ]
    blocker.open()
    await Promise.all(tasks)
    // quiet1 goes second, not last: the turns alternate between the owners that wait
    expect(started).toEqual(['busy1', 'busy2', 'quiet1', 'busy3', 'busy4'])
  })

  it('does not leave an owner behind when its queue empties and fills again', async () => {
    const semaphore = new Semaphore(1)
    const g = gate()
    const started: string[] = []
    const run = (owner: string, name: string, hold?: ReturnType<typeof gate>) =>
      semaphore.run(async () => {
        started.push(name)
        await hold?.opened
      }, owner)
    const tasks = [run('a', 'a1', g), run('a', 'a2'), run('a', 'a3')]
    // a2 and a3 wait; `b` arrives after a2 has been queued and must go before a3
    tasks.push(run('b', 'b1'))
    g.open()
    await Promise.all(tasks)
    expect(started).toEqual(['a1', 'a2', 'b1', 'a3'])
  })
})
