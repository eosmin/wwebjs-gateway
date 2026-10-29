// Runs the functions of one key one after another, in the order they were asked; different keys do
// not wait for each other. A function that fails does not stop the ones queued behind it. The lock
// lives in this process, which is enough because the gateway runs a single instance.
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    // The last one out removes the key, so keys that are no longer used do not pile up
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}
