import { readPackageInfo } from '../common/lib/package-info.js'
import type { Session } from '../database/models.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'

import { SystemService } from './system.service.js'

const session = (status: string): Session => ({ status }) as Session // reason: only the status is read

describe('SystemService', () => {
  const list = jest.fn<Promise<Session[]>, []>()
  const service = new SystemService({ list } as unknown as SessionsRepository) // reason: only list is called

  it('reports the versions of the manifest, the runtime and the uptime', async () => {
    list.mockResolvedValue([])

    const info = await service.info()

    expect(info.gatewayVersion).toBe(readPackageInfo().gatewayVersion)
    expect(info.wwebjsVersion).toBe(readPackageInfo().wwebjsVersion)
    expect(info.nodeVersion).toBe(process.versions.node)
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0)
  })

  it('counts the sessions by status, with every status present', async () => {
    list.mockResolvedValue([session('ready'), session('ready'), session('qr')])

    const { sessions } = await service.info()

    expect(sessions.total).toBe(3)
    expect(sessions.byStatus).toMatchObject({ ready: 2, qr: 1, failed: 0, created: 0 })
    expect(Object.keys(sessions.byStatus)).toHaveLength(9)
  })
})
