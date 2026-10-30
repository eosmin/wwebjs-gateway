// Lets at most `permits` tasks run at once; the others wait their turn in the order they came
export class Semaphore {
  private free: number
  private readonly waiting: (() => void)[] = []

  constructor(permits: number) {
    this.free = permits
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1
      return Promise.resolve()
    }
    return new Promise(resolve => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free += 1
  }
}
