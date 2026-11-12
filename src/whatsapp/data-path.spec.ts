import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DataPathGuard, assertDataPathUsable, isDataPathWritable } from './data-path.js'

describe('data path', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wwebjs-data-path-'))
  })

  afterEach(async () => {
    await chmod(root, 0o700)
    await rm(root, { recursive: true, force: true })
  })

  it('creates the folder when it does not exist and leaves nothing behind', async () => {
    const path = join(root, 'a', 'b')

    await expect(assertDataPathUsable(path)).resolves.toBeUndefined()
    await expect(isDataPathWritable(path)).resolves.toBe(true)
  })

  it('refuses a path that cannot be a folder, naming the variable and the reason', async () => {
    const file = join(root, 'file')
    await writeFile(file, 'x')

    await expect(assertDataPathUsable(join(file, 'sessions'))).rejects.toThrow(
      /WWEBJS_DATA_PATH is not usable \((ENOTDIR|EEXIST)\)/
    )
    await expect(isDataPathWritable(join(file, 'sessions'))).resolves.toBe(false)
  })

  it('refuses a folder that is not writable', async () => {
    // A root user writes anywhere, so the check is skipped for it
    if (process.getuid?.() === 0) return
    await chmod(root, 0o500)

    await expect(assertDataPathUsable(join(root, 'sessions'))).rejects.toThrow(
      /WWEBJS_DATA_PATH is not usable \(EACCES\)/
    )
    await expect(isDataPathWritable(root)).resolves.toBe(false)
  })

  it('stops the start of the application when the path is unusable', async () => {
    const file = join(root, 'file')
    await writeFile(file, 'x')
    const guard = new DataPathGuard({ WWEBJS_DATA_PATH: join(file, 'sessions') })

    await expect(guard.onModuleInit()).rejects.toThrow('WWEBJS_DATA_PATH is not usable')
  })

  it('lets the application start on a usable path', async () => {
    const guard = new DataPathGuard({ WWEBJS_DATA_PATH: join(root, 'sessions') })

    await expect(guard.onModuleInit()).resolves.toBeUndefined()
  })
})
