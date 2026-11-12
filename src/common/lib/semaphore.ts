// Lets at most `permits` tasks run at once. The others wait their turn: the tasks of one owner keep
// the order they came in, and a freed permit goes to the owner that has waited longest since its last
// turn, so an owner with a long line cannot keep the others out (a task without owner is one owner).
const NO_OWNER = Symbol('no owner')

export class Semaphore {
  private free: number
  // The owners in the order of their next turn; a Map keeps the order of insertion
  private readonly waiting = new Map<unknown, (() => void)[]>()

  constructor(permits: number) {
    this.free = permits
  }

  async run<T>(task: () => Promise<T>, owner: unknown = NO_OWNER): Promise<T> {
    await this.acquire(owner)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(owner: unknown): Promise<void> {
    if (this.free > 0 && this.waiting.size === 0) {
      this.free -= 1
      return Promise.resolve()
    }
    return new Promise(resolve => {
      const line = this.waiting.get(owner)
      if (line) line.push(resolve)
      else this.waiting.set(owner, [resolve])
    })
  }

  private release(): void {
    const first = this.waiting.entries().next()
    if (first.done) {
      this.free += 1
      return
    }
    const [owner, line] = first.value
    const next = line.shift()
    this.waiting.delete(owner)
    // An owner that still waits goes to the back of the rotation
    if (line.length > 0) this.waiting.set(owner, line)
    next?.()
  }
}
