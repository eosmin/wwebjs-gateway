import { releaseProfileLock, type ProfileLockEnvironment } from './profile-lock.js'
import { WaProfileLockedError } from './wa-errors.js'

const DIR = '/data/session-a'
const HOST = 'gateway-host'

interface Setup {
  env: ProfileLockEnvironment
  removed: string[]
  signals: string[]
  alive: Set<number>
}

// A world with the given lock target and processes; SIGTERM ends a process unless `ignoreTerm`
function world(options: {
  lock?: string
  alive?: number[]
  process?: { parentPid: number; command: string }
  ignoreTerm?: boolean
  ignoreKill?: boolean
  ownPid?: number
}): Setup {
  const alive = new Set(options.alive ?? [])
  const removed: string[] = []
  const signals: string[] = []
  const env: ProfileLockEnvironment = {
    readLock: () => Promise.resolve(options.lock),
    remove: path => {
      removed.push(path)
      return Promise.resolve()
    },
    hostname: () => HOST,
    ownPid: options.ownPid ?? 4000,
    isAlive: pid => alive.has(pid),
    inspect: pid => Promise.resolve(alive.has(pid) ? options.process : undefined),
    signal: (pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGTERM' && !options.ignoreTerm) alive.delete(pid)
      if (signal === 'SIGKILL' && !options.ignoreKill) alive.delete(pid)
    },
    sleep: () => Promise.resolve()
  }
  return { env, removed, signals, alive }
}

const ORPHAN = { parentPid: 1, command: `/usr/bin/chrome --headless --user-data-dir=${DIR} --x` }

describe('releaseProfileLock', () => {
  it('does nothing when there is no lock', async () => {
    const w = world({})
    await expect(releaseProfileLock(DIR, w.env)).resolves.toBe('free')
    expect(w.removed).toEqual([])
  })

  it('removes the lock of a process that is dead', async () => {
    const w = world({ lock: `${HOST}-123` })
    await expect(releaseProfileLock(DIR, w.env)).resolves.toBe('stale-lock-removed')
    expect(w.removed).toEqual([
      `${DIR}/SingletonLock`,
      `${DIR}/SingletonCookie`,
      `${DIR}/SingletonSocket`
    ])
  })

  it('removes the lock of another host, whose pid means nothing here', async () => {
    const w = world({ lock: 'old-container-123', alive: [123], process: ORPHAN })
    await expect(releaseProfileLock(DIR, w.env)).resolves.toBe('stale-lock-removed')
    expect(w.signals).toEqual([])
  })

  it('removes a lock it cannot parse', async () => {
    const w = world({ lock: '' })
    await expect(releaseProfileLock(DIR, w.env)).resolves.toBe('stale-lock-removed')
  })

  it('closes an orphaned browser of this very profile, then removes the lock', async () => {
    const w = world({ lock: `${HOST}-123`, alive: [123], process: ORPHAN })
    await expect(releaseProfileLock(DIR, w.env)).resolves.toBe('orphan-closed')
    expect(w.signals).toEqual(['SIGTERM'])
    expect(w.removed).toContain(`${DIR}/SingletonLock`)
  })

  it('kills an orphan that ignores the polite signal', async () => {
    const w = world({ lock: `${HOST}-123`, alive: [123], process: ORPHAN, ignoreTerm: true })
    await expect(releaseProfileLock(DIR, w.env)).resolves.toBe('orphan-closed')
    expect(w.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('throws when the orphan does not exit even after the kill', async () => {
    const w = world({
      lock: `${HOST}-123`,
      alive: [123],
      process: ORPHAN,
      ignoreTerm: true,
      ignoreKill: true
    })
    await expect(releaseProfileLock(DIR, w.env)).rejects.toBeInstanceOf(WaProfileLockedError)
    expect(w.removed).toEqual([])
  })

  it('never touches a live process that has a parent (it may be a browser of this gateway)', async () => {
    const w = world({
      lock: `${HOST}-123`,
      alive: [123],
      process: { parentPid: 4000, command: ORPHAN.command }
    })
    await expect(releaseProfileLock(DIR, w.env)).rejects.toMatchObject({ pid: 123 })
    expect(w.signals).toEqual([])
    expect(w.removed).toEqual([])
  })

  it('treats the lock as stale when its pid now belongs to a process of another profile', async () => {
    const w = world({
      lock: `${HOST}-123`,
      alive: [123],
      process: { parentPid: 1, command: '/usr/bin/chrome --user-data-dir=/data/session-ab' }
    })
    await expect(releaseProfileLock(DIR, w.env)).resolves.toBe('stale-lock-removed')
    expect(w.signals).toEqual([])
  })

  it('waits for a browser that is a child of this gateway instead of closing it', async () => {
    const w = world({
      lock: `${HOST}-123`,
      alive: [123],
      process: { parentPid: 4000, command: ORPHAN.command }
    })
    await expect(releaseProfileLock(DIR, w.env)).rejects.toThrow(/still closing/)
  })

  it('never touches a process it cannot identify', async () => {
    const w = world({ lock: `${HOST}-123`, alive: [123] })
    await expect(releaseProfileLock(DIR, w.env)).rejects.toBeInstanceOf(WaProfileLockedError)
    expect(w.signals).toEqual([])
  })

  it('never closes anything when the gateway is itself init (a container without a supervisor)', async () => {
    const w = world({ lock: `${HOST}-123`, alive: [123], process: ORPHAN, ownPid: 1 })
    await expect(releaseProfileLock(DIR, w.env)).rejects.toBeInstanceOf(WaProfileLockedError)
    expect(w.signals).toEqual([])
  })

  it('says the pid and what to do, and leaks no path', async () => {
    const w = world({
      lock: `${HOST}-123`,
      alive: [123],
      process: { parentPid: 7, command: ORPHAN.command }
    })
    const error = await releaseProfileLock(DIR, w.env).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WaProfileLockedError)
    expect((error as Error).message).toMatch(/process 123/)
    expect((error as Error).message).not.toContain(DIR)
  })
})
