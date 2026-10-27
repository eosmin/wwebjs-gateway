import { Logger } from '@nestjs/common'
import type { TestingModule } from '@nestjs/testing'

import { PrismaService } from '../../src/database/prisma.service.js'
import { buildDatabaseModule, databaseUrl } from '../helpers/database.js'

describe('PrismaService (integration)', () => {
  let module: TestingModule | undefined

  const build = async (url: URL): Promise<TestingModule> => {
    module = await buildDatabaseModule(url)
    return module
  }

  // Closes the pool even when an assertion failed, so a failure does not leave a handle open
  afterEach(async () => {
    await module?.close()
    module = undefined
  })

  it('connects on init, answers queries and disconnects on destroy', async () => {
    const built = await build(databaseUrl())
    await built.init()
    const prisma = built.get(PrismaService)

    expect(await prisma.$queryRaw`SELECT 1 AS ok`).toEqual([{ ok: 1 }])
    // The migration of step 2.2 created the tables
    expect(await prisma.session.count()).toBeGreaterThanOrEqual(0)

    const disconnect = jest.spyOn(prisma, '$disconnect')
    await built.close()
    module = undefined

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('fails the boot at once, without retrying, when the password is wrong', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const url = databaseUrl()
    url.password = 'not-the-password'
    const built = await build(url)

    await expect(built.init()).rejects.toThrow(/28P01|password authentication failed/)

    // A retry would log a second attempt; the one line never carries the password
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/attempt 1 failed/)
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('not-the-password')
    warn.mockRestore()
  })
})
