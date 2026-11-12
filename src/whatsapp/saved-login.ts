import { chmod, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

// The saved login of a session is the folder LocalAuth keeps in WWEBJS_DATA_PATH (`session-<id>`).
// This module moves it aside and removes it for good only after a waiting time, and needs no browser
// and no client. It never deletes a login: a login that WhatsApp did not really revoke (a network
// fault looked like one) can be put back by moving the folder again.

const SESSION_ID = /^[-_\w]{1,64}$/
export const QUARANTINE_DIR = '.quarantine'
export const DAY_MS = 86_400_000
// `session-<id>-<ms since epoch>`; the id may contain hyphens and digits, the stamp is the last part
const QUARANTINED = /^session-([-_\w]{1,64})-(\d{10,})$/

// The folder of this session, or an error: an id that is not valid could leave the data folder
export function profileDirOf(dataPath: string, id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('invalid session id')
  const root = resolve(dataPath)
  const dir = resolve(root, `session-${id}`)
  if (!dir.startsWith(root + sep)) throw new Error('profile folder outside the data folder')
  return dir
}

const quarantineRoot = (dataPath: string): string => join(resolve(dataPath), QUARANTINE_DIR)

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// A real folder, not a link to one: the quarantine is never read or cleaned through a symlink
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

export const hasSavedLogin = (dataPath: string, id: string): Promise<boolean> =>
  isDirectory(profileDirOf(dataPath, id))

// Moves the folder to `.quarantine/session-<id>-<ms>` (a rename inside the data folder: atomic, no
// copy). Resolves to where it went, or undefined when there was nothing to move.
export async function quarantineSavedLogin(
  dataPath: string,
  id: string,
  now: Date = new Date()
): Promise<string | undefined> {
  const source = profileDirOf(dataPath, id)
  if (!(await isDirectory(source))) return undefined
  const root = quarantineRoot(dataPath)
  await mkdir(root, { recursive: true, mode: 0o700 })
  // An existing folder keeps its mode in `mkdir`, and the umask can narrow a new one: say it
  await chmod(root, 0o700)
  if (!(await isRealDirectory(root))) throw new Error('quarantine folder is not a folder')
  const target = join(root, `session-${id}-${now.getTime()}`)
  // Never over an earlier quarantine of the same millisecond
  if (await isDirectory(target)) throw new Error('quarantine target exists')
  await rename(source, target)
  return target
}

async function quarantined(dataPath: string): Promise<{ id: string; at: number; path: string }[]> {
  const root = quarantineRoot(dataPath)
  if (!(await isRealDirectory(root))) return []
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const found: { id: string; at: number; path: string }[] = []
  for (const name of names) {
    const match = QUARANTINED.exec(name)
    if (match?.[1] && match[2] && (await isRealDirectory(join(root, name))))
      found.push({ id: match[1], at: Number(match[2]), path: join(root, name) })
  }
  return found
}

// Was the login of this session quarantined within the last `windowMs`? Read from the folder names, so
// the answer survives a restart of the gateway.
export async function wasQuarantinedWithin(
  dataPath: string,
  id: string,
  windowMs: number,
  now: Date = new Date()
): Promise<boolean> {
  profileDirOf(dataPath, id)
  return (await quarantined(dataPath)).some(
    entry => entry.id === id && now.getTime() - entry.at < windowMs
  )
}

// Removes what has been in quarantine for longer than `ttlMs`. Only entries named by
// `quarantineSavedLogin` inside `.quarantine` are looked at; anything else there stays.
export async function purgeExpiredQuarantine(
  dataPath: string,
  ttlMs: number,
  now: Date = new Date()
): Promise<number> {
  let removed = 0
  for (const entry of await quarantined(dataPath)) {
    if (now.getTime() - entry.at < ttlMs) continue
    await rm(entry.path, { recursive: true, force: true })
    removed++
  }
  return removed
}
