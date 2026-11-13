import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DAY_MS,
  hasSavedLogin,
  profileDirOf,
  purgeExpiredQuarantine,
  quarantineSavedLogin,
  restoreSavedLogin,
  wasQuarantinedWithin
} from './saved-login.js'

const NOW = new Date('2026-11-13T12:00:00.000Z')
let dataPath: string

beforeEach(() => {
  dataPath = mkdtempSync(join(tmpdir(), 'saved-login-'))
})
afterEach(() => {
  rmSync(dataPath, { recursive: true, force: true })
})

function seedLogin(id: string, content = 'cookie'): string {
  const dir = join(dataPath, `session-${id}`)
  mkdirSync(join(dir, 'Default'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Cookies'), content)
  return dir
}

describe('profileDirOf', () => {
  it('names the folder LocalAuth uses', () => {
    expect(profileDirOf(dataPath, 'support-line')).toBe(join(dataPath, 'session-support-line'))
  })

  it.each(['../evil', 'a/b', '..', '', 'x'.repeat(65), 'a b', 'a\0b'])(
    'refuses the id %j, which could leave the data folder',
    id => {
      expect(() => profileDirOf(dataPath, id)).toThrow()
    }
  )
})

describe('quarantineSavedLogin', () => {
  it('moves the folder with its content and never deletes it', async () => {
    seedLogin('line-1', 'secret-token')

    const target = await quarantineSavedLogin(dataPath, 'line-1', NOW)

    expect(target).toBe(join(dataPath, '.quarantine', `session-line-1-${NOW.getTime()}`))
    expect(existsSync(join(dataPath, 'session-line-1'))).toBe(false)
    expect(readFileSync(join(target ?? '', 'Default', 'Cookies'), 'utf8')).toBe('secret-token')
    await expect(hasSavedLogin(dataPath, 'line-1')).resolves.toBe(false)
  })

  it('answers undefined when there is no login to move, and creates nothing', async () => {
    await expect(quarantineSavedLogin(dataPath, 'line-1', NOW)).resolves.toBeUndefined()
    expect(existsSync(join(dataPath, '.quarantine'))).toBe(false)
  })

  it('moves only the folder of the session asked for', async () => {
    seedLogin('line-1')
    seedLogin('line-2')

    await quarantineSavedLogin(dataPath, 'line-1', NOW)

    expect(existsSync(join(dataPath, 'session-line-2'))).toBe(true)
  })

  it('refuses a session id that would leave the data folder, touching nothing', async () => {
    // What `../escape` would name if the id were joined without a check
    const target = join(dataPath, '..', 'escape')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'file'), 'keep')
    try {
      await expect(quarantineSavedLogin(dataPath, '../escape', NOW)).rejects.toThrow()
      expect(readFileSync(join(target, 'file'), 'utf8')).toBe('keep')
      expect(existsSync(join(dataPath, '.quarantine'))).toBe(false)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('never writes over an earlier quarantine of the same instant', async () => {
    seedLogin('line-1', 'first')
    const first = await quarantineSavedLogin(dataPath, 'line-1', NOW)
    seedLogin('line-1', 'second')

    await expect(quarantineSavedLogin(dataPath, 'line-1', NOW)).rejects.toThrow('exists')

    expect(readFileSync(join(first ?? '', 'Default', 'Cookies'), 'utf8')).toBe('first')
    expect(existsSync(join(dataPath, 'session-line-1'))).toBe(true)
  })
})

describe('wasQuarantinedWithin', () => {
  it('is true for a quarantine inside the window and false outside it or for another session', async () => {
    seedLogin('line-1')
    await quarantineSavedLogin(dataPath, 'line-1', new Date(NOW.getTime() - DAY_MS / 2))

    await expect(wasQuarantinedWithin(dataPath, 'line-1', DAY_MS, NOW)).resolves.toBe(true)
    await expect(wasQuarantinedWithin(dataPath, 'line-1', DAY_MS / 4, NOW)).resolves.toBe(false)
    await expect(wasQuarantinedWithin(dataPath, 'line-2', DAY_MS, NOW)).resolves.toBe(false)
  })

  it('does not mistake a session whose id ends like another one', async () => {
    seedLogin('line-1')
    await quarantineSavedLogin(dataPath, 'line-1', NOW)

    await expect(wasQuarantinedWithin(dataPath, 'line', DAY_MS, NOW)).resolves.toBe(false)
  })

  it('is false when nothing was ever quarantined', async () => {
    await expect(wasQuarantinedWithin(dataPath, 'line-1', DAY_MS, NOW)).resolves.toBe(false)
  })
})

describe('purgeExpiredQuarantine', () => {
  it('removes what is older than the waiting time and keeps the rest', async () => {
    seedLogin('old')
    await quarantineSavedLogin(dataPath, 'old', new Date(NOW.getTime() - 8 * DAY_MS))
    seedLogin('fresh')
    await quarantineSavedLogin(dataPath, 'fresh', new Date(NOW.getTime() - 6 * DAY_MS))

    await expect(purgeExpiredQuarantine(dataPath, 7 * DAY_MS, NOW)).resolves.toBe(1)

    expect(readdirSync(join(dataPath, '.quarantine'))).toEqual([
      `session-fresh-${NOW.getTime() - 6 * DAY_MS}`
    ])
  })

  it('touches nothing else: live logins, other folders and names it did not make', async () => {
    seedLogin('live')
    mkdirSync(join(dataPath, '.quarantine', 'notes'), { recursive: true })
    mkdirSync(join(dataPath, '.quarantine', 'session-x-123'), { recursive: true })
    mkdirSync(join(dataPath, 'other'), { recursive: true })

    await expect(purgeExpiredQuarantine(dataPath, 0, NOW)).resolves.toBe(0)

    expect(existsSync(join(dataPath, 'session-live'))).toBe(true)
    expect(existsSync(join(dataPath, 'other'))).toBe(true)
    expect(readdirSync(join(dataPath, '.quarantine')).sort()).toEqual(['notes', 'session-x-123'])
  })

  it('answers 0 when there is no quarantine folder', async () => {
    await expect(purgeExpiredQuarantine(dataPath, 0, NOW)).resolves.toBe(0)
  })
})

describe('symlinks in the quarantine', () => {
  it('does not purge through a symlinked quarantine folder', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    try {
      mkdirSync(join(elsewhere, `session-x-${NOW.getTime() - 30 * DAY_MS}`))
      symlinkSync(elsewhere, join(dataPath, '.quarantine'))

      await expect(purgeExpiredQuarantine(dataPath, DAY_MS, NOW)).resolves.toBe(0)
      expect(readdirSync(elsewhere)).toHaveLength(1)
      seedLogin('line-1')
      await expect(quarantineSavedLogin(dataPath, 'line-1', NOW)).rejects.toThrow()
      expect(existsSync(join(dataPath, 'session-line-1'))).toBe(true)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('never changes the mode of what a symlinked quarantine folder points at', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    try {
      chmodSync(elsewhere, 0o755)
      symlinkSync(elsewhere, join(dataPath, '.quarantine'))
      seedLogin('line-1')

      await expect(quarantineSavedLogin(dataPath, 'line-1', NOW)).rejects.toThrow()

      expect(statSync(elsewhere).mode & 0o777).toBe(0o755)
      expect(existsSync(join(dataPath, 'session-line-1'))).toBe(true)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('does not purge an entry that is a symlink', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    try {
      mkdirSync(join(dataPath, '.quarantine'))
      symlinkSync(
        elsewhere,
        join(dataPath, '.quarantine', `session-x-${NOW.getTime() - 30 * DAY_MS}`)
      )

      await expect(purgeExpiredQuarantine(dataPath, DAY_MS, NOW)).resolves.toBe(0)
      expect(existsSync(elsewhere)).toBe(true)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('tightens the mode of an existing quarantine folder', async () => {
    mkdirSync(join(dataPath, '.quarantine'), { mode: 0o755 })
    seedLogin('line-1')

    await quarantineSavedLogin(dataPath, 'line-1', NOW)

    expect(statSync(join(dataPath, '.quarantine')).mode & 0o777).toBe(0o700)
  })
})

describe('the login of a deleted session', () => {
  it('goes to a folder that says it was removed, and does not count as an automatic quarantine', async () => {
    seedLogin('line-1', 'secret-token')

    const target = await quarantineSavedLogin(dataPath, 'line-1', NOW, { removed: true })

    expect(target).toBe(join(dataPath, '.quarantine', `removed-session-line-1-${NOW.getTime()}`))
    expect(readFileSync(join(target ?? '', 'Default', 'Cookies'), 'utf8')).toBe('secret-token')
    // A session created again under the same id may still be quarantined on its own
    await expect(wasQuarantinedWithin(dataPath, 'line-1', DAY_MS, NOW)).resolves.toBe(false)
  })

  it('is deleted for good after the waiting time like any quarantine, and not before', async () => {
    mkdirSync(join(dataPath, '.quarantine', `removed-session-a-${NOW.getTime() - 8 * DAY_MS}`), {
      recursive: true
    })
    mkdirSync(join(dataPath, '.quarantine', `removed-session-b-${NOW.getTime() - 2 * DAY_MS}`), {
      recursive: true
    })

    await expect(purgeExpiredQuarantine(dataPath, 7 * DAY_MS, NOW)).resolves.toBe(1)

    expect(readdirSync(join(dataPath, '.quarantine'))).toEqual([
      `removed-session-b-${NOW.getTime() - 2 * DAY_MS}`
    ])
  })
})

describe('restoreSavedLogin', () => {
  it('puts a moved login back where LocalAuth looks for it', async () => {
    seedLogin('line-1', 'secret-token')
    const target = await quarantineSavedLogin(dataPath, 'line-1', NOW, { removed: true })

    await expect(restoreSavedLogin(dataPath, 'line-1', target ?? '')).resolves.toBe(true)

    expect(readFileSync(join(dataPath, 'session-line-1', 'Default', 'Cookies'), 'utf8')).toBe(
      'secret-token'
    )
    expect(existsSync(target ?? '')).toBe(false)
  })

  it('never writes over a login that is there already', async () => {
    seedLogin('line-1', 'old')
    const target = await quarantineSavedLogin(dataPath, 'line-1', NOW)
    seedLogin('line-1', 'new')

    await expect(restoreSavedLogin(dataPath, 'line-1', target ?? '')).resolves.toBe(false)

    expect(readFileSync(join(dataPath, 'session-line-1', 'Default', 'Cookies'), 'utf8')).toBe('new')
    expect(existsSync(target ?? '')).toBe(true)
  })

  it('refuses a folder that is not inside the quarantine of this data folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    try {
      await expect(restoreSavedLogin(dataPath, 'line-1', outside)).resolves.toBe(false)
      expect(existsSync(outside)).toBe(true)
      expect(existsSync(join(dataPath, 'session-line-1'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
