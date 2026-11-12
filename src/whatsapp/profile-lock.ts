import { execFile } from 'node:child_process'
import { readlink, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { promisify } from 'node:util'

import { WaProfileLockedError } from './wa-errors.js'

// Chromium locks its profile with a symlink `SingletonLock -> <host>-<pid>` (plus `SingletonCookie`
// and `SingletonSocket`) and never removes it when it is killed. A gateway that dies without closing
// its browsers (kill -9, a crash, the OOM killer) leaves the lock behind and often the browser too, and
// the next browser of that profile then refuses to start. This looks at the lock of one session
// profile before each start and clears what is certainly ours to clear, and nothing else.

const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const
const TERM_GRACE_MS = 5000
const POLL_MS = 100
const PS_TIMEOUT_MS = 3000

export interface ProcessInfo {
  parentPid: number
  command: string
}

// Everything the check touches outside itself, so the tests need no browser and no real process
export interface ProfileLockEnvironment {
  readLock(path: string): Promise<string | undefined>
  remove(path: string): Promise<void>
  hostname(): string
  // The pid of this gateway
  ownPid: number
  isAlive(pid: number): boolean
  inspect(pid: number): Promise<ProcessInfo | undefined>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  sleep(ms: number): Promise<void>
}

export type ProfileLockOutcome = 'free' | 'stale-lock-removed' | 'orphan-closed'

const run = promisify(execFile)

// Errors from `fs` and `process` can come from another realm (a test runner), so `instanceof Error`
// would not tell; the code is read structurally
const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined

const realEnvironment: ProfileLockEnvironment = {
  async readLock(path) {
    try {
      return await readlink(path)
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return undefined
      // Not a symlink, or unreadable: a lock this module does not understand counts as junk
      return ''
    }
  },
  remove: path => rm(path, { force: true }),
  hostname,
  ownPid: process.pid,
  isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error: unknown) {
      // EPERM: it exists and belongs to somebody else
      return errorCode(error) !== 'ESRCH'
    }
  },
  async inspect(pid) {
    try {
      // The same flags on Linux (procps, which the image installs) and macOS
      const { stdout } = await run('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        timeout: PS_TIMEOUT_MS
      })
      const match = /^\s*(\d+)\s+(.+)$/s.exec(stdout.trim())
      if (!match?.[1] || !match[2]) return undefined
      return { parentPid: Number(match[1]), command: match[2] }
    } catch {
      return undefined
    }
  },
  signal(pid, signal) {
    process.kill(pid, signal)
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
}

// The browser of this profile: its command line names the profile directory exactly (a longer path
// that starts with ours, such as `session-a` and `session-ab`, is another profile)
function launchedForProfile(command: string, profileDir: string): boolean {
  const flag = `--user-data-dir=${profileDir}`
  let from = command.indexOf(flag)
  while (from !== -1) {
    const next = command[from + flag.length]
    if (next === undefined || next === ' ') return true
    from = command.indexOf(flag, from + 1)
  }
  return false
}

async function removeLock(profileDir: string, env: ProfileLockEnvironment): Promise<void> {
  for (const name of LOCK_FILES) await env.remove(`${profileDir}/${name}`)
}

async function closeOrphan(pid: number, env: ProfileLockEnvironment): Promise<boolean> {
  const ends = async (grace: number): Promise<boolean> => {
    for (let waited = 0; waited < grace; waited += POLL_MS) {
      if (!env.isAlive(pid)) return true
      await env.sleep(POLL_MS)
    }
    return !env.isAlive(pid)
  }
  try {
    env.signal(pid, 'SIGTERM')
    if (await ends(TERM_GRACE_MS)) return true
    env.signal(pid, 'SIGKILL')
  } catch {
    // The process ended between the check and the signal
  }
  return await ends(TERM_GRACE_MS)
}

// Makes the profile free for a new browser, or throws WaProfileLockedError when something that is not
// ours holds it. It closes a browser only when all of these hold: the lock names a live process of this
// host, that process was started with this very profile directory, and its parent is init (it was
// orphaned: the gateway that started it is gone). Any other live process is left alone.
export async function releaseProfileLock(
  profileDir: string,
  env: ProfileLockEnvironment = realEnvironment
): Promise<ProfileLockOutcome> {
  const target = await env.readLock(`${profileDir}/SingletonLock`)
  if (target === undefined) return 'free'

  const match = /^(.+)-(\d+)$/.exec(target)
  const pid = match?.[2] ? Number(match[2]) : undefined
  // A lock of another host (a container that was replaced), or one that does not parse, names no
  // process this gateway could be running
  if (!match || pid === undefined || match[1] !== env.hostname() || !env.isAlive(pid)) {
    await removeLock(profileDir, env)
    return 'stale-lock-removed'
  }

  const info = await env.inspect(pid)
  if (!info) {
    // `ps` failed or the process just ended
    if (env.isAlive(pid)) throw new WaProfileLockedError(pid, 'its owner could not be identified')
    await removeLock(profileDir, env)
    return 'stale-lock-removed'
  }
  // A live process that was not started for this profile is not what the lock stands for: the pid
  // was reused (a restart of the container keeps the host name) and the lock is stale
  if (!launchedForProfile(info.command, profileDir)) {
    await removeLock(profileDir, env)
    return 'stale-lock-removed'
  }
  if (info.parentPid === env.ownPid) {
    throw new WaProfileLockedError(pid, 'a browser of this gateway is still closing')
  }
  if (info.parentPid !== 1 || env.ownPid === 1) {
    throw new WaProfileLockedError(pid, 'it does not belong to this gateway')
  }
  if (!(await closeOrphan(pid, env))) {
    throw new WaProfileLockedError(pid, 'it did not exit when asked to')
  }
  await removeLock(profileDir, env)
  return 'orphan-closed'
}
