import { PolicyState } from '../../src/services/send-policy.state.js'
import { PolicyStateStore, UnreadablePolicyState } from '../../src/services/send-policy.store.js'

// An in-memory PolicyStateStore for the unit tests. It keeps JSON text, as Redis does, so a state
// that does not survive serialization fails the test. `failing` makes every call fail.
export class FakePolicyStateStore extends PolicyStateStore {
  readonly states = new Map<string, string>()
  readonly flags = new Set<string>()
  failing = false
  // Every call waits forever, as a Redis client does while the server is down
  hanging = false
  private readonly heldLoads: Promise<void>[] = []
  private readonly heldDeletes: Promise<void>[] = []

  // The next `delete` acts only when the returned function is called: a slow Redis
  releaseNextDelete(): () => void {
    let release!: () => void
    this.heldDeletes.push(
      new Promise<void>(done => {
        release = done
      })
    )
    return release
  }

  // The next `load` reads now and answers only when the returned function is called: a slow Redis
  releaseNextLoad(): () => void {
    let release!: () => void
    this.heldLoads.push(
      new Promise<void>(done => {
        release = done
      })
    )
    return release
  }

  // Runs the body as a promise, so a throw becomes a rejection like a Redis error would
  private run<T>(body: () => T): Promise<T> {
    if (this.hanging) return new Promise<T>(() => undefined)
    return Promise.resolve().then(() => {
      if (this.failing) throw new Error('store down')
      return body()
    })
  }

  load(sessionId: string): Promise<PolicyState | null> {
    const held = this.heldLoads.shift()
    return this.run(() => {
      const raw = this.states.get(sessionId)
      if (raw === undefined) return null
      try {
        return PolicyState.parse(JSON.parse(raw))
      } catch {
        throw new UnreadablePolicyState(sessionId)
      }
    }).then(async state => {
      await held
      return state
    })
  }

  save(sessionId: string, state: PolicyState): Promise<void> {
    return this.run(() => {
      this.states.set(sessionId, JSON.stringify(state))
    })
  }

  flagUnreachable(sessionId: string, chatId: string): Promise<boolean> {
    return this.run(() => {
      const key = `${sessionId}:${chatId}`
      const added = !this.flags.has(key)
      this.flags.add(key)
      return added
    })
  }

  clearUnreachable(sessionId: string, chatId: string): Promise<boolean> {
    return this.run(() => this.flags.delete(`${sessionId}:${chatId}`))
  }

  listUnreachable(sessionId: string, limit: number): Promise<string[]> {
    return this.run(() =>
      [...this.flags]
        .filter(key => key.startsWith(`${sessionId}:`))
        .map(key => key.slice(sessionId.length + 1))
        .slice(0, limit)
    )
  }

  delete(sessionId: string): Promise<void> {
    const held = this.heldDeletes.shift()
    return (held ?? Promise.resolve()).then(() =>
      this.run(() => {
        this.states.delete(sessionId)
        for (const key of this.flags) if (key.startsWith(`${sessionId}:`)) this.flags.delete(key)
      })
    )
  }
}
