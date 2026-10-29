import { readPackageInfo } from '../common/lib/package-info.js'
import type { Session } from '../database/models.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { RunningSession, SessionManager } from '../whatsapp/session-manager.service.js'

import { SystemService } from './system.service.js'

const session = (status: string, id = 'main'): Session => ({ id, status }) as Session // reason: only the id and the status are read
const run = (id: string, status: string, getWWebVersion: () => Promise<string>): RunningSession =>
  ({ id, status, client: { getWWebVersion } }) as unknown as RunningSession // reason: only the version is read

describe('SystemService', () => {
  const list = jest.fn<Promise<Session[]>, []>()
  const running = jest.fn<RunningSession[], []>()
  const service = new SystemService(
    { list } as unknown as SessionsRepository, // reason: only list is called
    { running } as unknown as SessionManager // reason: only running is called
  )

  beforeEach(() => {
    running.mockReturnValue([])
  })

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

  it('names the WhatsApp Web version of a ready session and leaves the others null', async () => {
    list.mockResolvedValue([session('ready', 'a'), session('qr', 'b')])
    running.mockReturnValue([
      run('a', 'ready', () => Promise.resolve('2.3000.1')),
      run('b', 'authenticating', () => Promise.resolve('x'))
    ])

    const { sessions } = await service.info()

    expect(sessions.items).toEqual([
      { id: 'a', status: 'ready', wwebVersion: '2.3000.1' },
      { id: 'b', status: 'authenticating', wwebVersion: null }
    ])
  })

  it('reports no version when the page does not answer, instead of failing', async () => {
    list.mockResolvedValue([session('ready', 'a')])
    running.mockReturnValue([run('a', 'ready', () => Promise.reject(new Error('timeout')))])

    const { sessions } = await service.info()

    expect(sessions.items).toEqual([{ id: 'a', status: 'ready', wwebVersion: null }])
  })

  it('takes the status of a running session from memory, which can be ahead of the row', async () => {
    list.mockResolvedValue([session('ready', 'a')])
    running.mockReturnValue([run('a', 'disconnected', () => Promise.resolve('x'))])

    const { sessions } = await service.info()

    expect(sessions.items).toEqual([{ id: 'a', status: 'disconnected', wwebVersion: null }])
    // The counts follow the same statuses as the items
    expect(sessions.byStatus).toMatchObject({ disconnected: 1, ready: 0 })
  })

  it('keeps the status of the row for a session that does not run, and ignores a run with no row', async () => {
    list.mockResolvedValue([session('ready', 'a')])
    running.mockReturnValue([run('ghost', 'ready', () => Promise.resolve('x'))])

    const { sessions } = await service.info()

    expect(sessions.items).toEqual([{ id: 'a', status: 'ready', wwebVersion: null }])
  })

  it('leaves the version of the other sessions intact when one page fails', async () => {
    list.mockResolvedValue([session('ready', 'a'), session('ready', 'b')])
    running.mockReturnValue([
      run('a', 'ready', () => Promise.reject(new Error('timeout'))),
      run('b', 'ready', () => Promise.resolve('2.3000.2'))
    ])

    const { sessions } = await service.info()

    expect(sessions.items).toEqual([
      { id: 'a', status: 'ready', wwebVersion: null },
      { id: 'b', status: 'ready', wwebVersion: '2.3000.2' }
    ])
  })
})
