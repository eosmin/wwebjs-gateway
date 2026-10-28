import { NotFoundError } from '../common/errors.js'
import type { Session } from '../database/models.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'

import { SessionsService, toSessionDto } from './sessions.service.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const row = (overrides: Partial<Session> = {}): Session => ({
  id: 'main',
  name: 'Main',
  status: 'ready',
  phoneNumber: '5215500000001',
  pushName: 'Support',
  autoStart: true,
  settings: { ordering: { enabled: true } },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:05:00.000Z'),
  lastConnectedAt: new Date('2026-01-01T00:04:00.000Z'),
  lastEventAt: null,
  linkedAt: null,
  lastError: null,
  seqHighWater: 1200n,
  ...overrides
})

describe('toSessionDto', () => {
  it('leaves out seqHighWater, so the DTO serializes although the row holds a bigint', () => {
    const dto = toSessionDto(row())

    expect(dto).not.toHaveProperty('seqHighWater')
    expect(() => JSON.stringify(dto)).not.toThrow()
  })

  it('writes the dates as ISO strings and keeps the missing ones null', () => {
    expect(toSessionDto(row())).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      lastConnectedAt: '2026-01-01T00:04:00.000Z',
      lastEventAt: null,
      linkedAt: null
    })
  })

  it('answers empty settings for a column that does not hold an object', () => {
    expect(toSessionDto(row({ settings: ['x'] })).settings).toEqual({})
  })
})

describe('SessionsService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    mergeSettings: jest.fn()
  }
  const manager = {
    create: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    restart: jest.fn(),
    logout: jest.fn(),
    remove: jest.fn(),
    resetState: jest.fn(),
    status: jest.fn(),
    qr: jest.fn(),
    requireReady: jest.fn()
  }
  const service = new SessionsService(
    repository as unknown as SessionsRepository, // reason: only the methods above are called
    manager as unknown as SessionManager // reason: only the methods above are called
  )

  beforeEach(() => {
    jest.resetAllMocks()
  })

  describe('reads', () => {
    it('lists every session as a DTO', async () => {
      repository.list.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })])

      const { sessions } = await service.list()

      expect(sessions.map(session => session.id)).toEqual(['a', 'b'])
    })

    it('answers 404 for a session that does not exist', async () => {
      repository.findById.mockResolvedValue(null)

      await expect(service.get('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    })
  })

  describe('create', () => {
    it('hands the options to the manager, which checks the id and the capacity', async () => {
      manager.create.mockResolvedValue(row({ status: 'created' }))

      const created = await service.create({ id: 'main', name: 'Main', autoStart: false })

      expect(manager.create).toHaveBeenCalledWith('main', { name: 'Main', autoStart: false })
      expect(created.status).toBe('created')
    })
  })

  describe('update', () => {
    it('merges the settings in the repository, apart from the other fields', async () => {
      repository.mergeSettings.mockResolvedValue(true)
      repository.update.mockResolvedValue(row({ name: 'Renamed' }))

      const updated = await service.update('main', {
        name: 'Renamed',
        settings: { backgroundSync: true }
      })

      expect(repository.mergeSettings).toHaveBeenCalledWith('main', { backgroundSync: true })
      expect(repository.update).toHaveBeenCalledWith('main', { name: 'Renamed' })
      expect(updated.name).toBe('Renamed')
    })

    it('only merges, and reads the row back, when the request has settings alone', async () => {
      repository.mergeSettings.mockResolvedValue(true)
      repository.findById.mockResolvedValue(row())

      await service.update('main', { settings: { ordering: { enabled: false } } })

      expect(repository.update).not.toHaveBeenCalled()
      expect(repository.findById).toHaveBeenCalledWith('main')
    })

    it('answers 404 when the row vanishes between the merge and the update of the other fields', async () => {
      repository.mergeSettings.mockResolvedValue(true)
      repository.update.mockResolvedValue(null)

      await expect(
        service.update('main', { name: 'x', settings: { backgroundSync: true } })
      ).rejects.toBeInstanceOf(NotFoundError)
    })

    it('does not touch the settings when the request has none', async () => {
      repository.update.mockResolvedValue(row())

      await service.update('main', { autoStart: false })

      expect(repository.mergeSettings).not.toHaveBeenCalled()
      expect(repository.update).toHaveBeenCalledWith('main', { autoStart: false })
    })

    it.each([
      [
        'the merge finds no session',
        () => repository.mergeSettings.mockResolvedValue(false),
        { settings: {} }
      ],
      [
        'the row vanished after the merge',
        () => {
          repository.mergeSettings.mockResolvedValue(true)
          repository.findById.mockResolvedValue(null)
        },
        { settings: {} }
      ],
      [
        'the update finds no session',
        () => repository.update.mockResolvedValue(null),
        { name: 'x' }
      ]
    ])('answers 404 when %s', async (_name, arrange, body) => {
      arrange()

      await expect(service.update('main', body)).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('lifecycle', () => {
    it.each(['start', 'stop', 'restart', 'logout'] as const)(
      '%s goes through the manager and answers the session',
      async command => {
        manager[command].mockResolvedValue(row({ status: 'starting' }))

        const session = await service[command]('main')

        expect(manager[command]).toHaveBeenCalledWith('main')
        expect(session.status).toBe('starting')
      }
    )

    it.each([
      ['create', 'SESSION_ALREADY_EXISTS'],
      ['start', 'MAX_SESSIONS_REACHED'],
      ['restart', 'NOT_FOUND']
    ] as const)('lets the error of the manager through on %s', async (command, code) => {
      const error = Object.assign(new Error('refused'), { code })
      manager.create.mockRejectedValue(error)
      manager.start.mockRejectedValue(error)
      manager.restart.mockRejectedValue(error)

      await expect(
        command === 'create' ? service.create({ id: 'main' }) : service[command]('main')
      ).rejects.toBe(error)
    })

    it('removes through the manager', async () => {
      manager.remove.mockResolvedValue(undefined)

      await service.remove('main')

      expect(manager.remove).toHaveBeenCalledWith('main')
    })
  })

  describe('QR code', () => {
    it('answers the text of the QR code with the status of the session', () => {
      manager.qr.mockReturnValue('2@abc')
      manager.status.mockReturnValue('qr')

      expect(service.qr('main')).toEqual({ qr: '2@abc', status: 'qr' })
    })

    it('answers 404 and names the status when there is nothing to scan', () => {
      manager.qr.mockReturnValue(undefined)
      manager.status.mockReturnValue('ready')

      expect(() => service.qr('main')).toThrow(/status ready/)
      expect(() => service.qr('main')).toThrow(NotFoundError)
    })

    it('draws the text of the QR code as a PNG image', async () => {
      manager.qr.mockReturnValue('2@abc')

      const png = await service.qrPng('main')
      const again = await service.qrPng('main')
      manager.qr.mockReturnValue('2@other')
      const other = await service.qrPng('main')

      expect(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true)
      expect(again.equals(png)).toBe(true)
      expect(other.equals(png)).toBe(false)
    })

    it('does not draw an image when there is no QR code', async () => {
      manager.qr.mockReturnValue(undefined)
      manager.status.mockReturnValue('stopped')

      await expect(service.qrPng('main')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('reads of the client', () => {
    const client = {
      getState: jest.fn(),
      getWWebVersion: jest.fn(),
      getClientInfo: jest.fn()
    }

    beforeEach(() => {
      manager.requireReady.mockReturnValue(client)
    })

    it('reads the state of a ready session', async () => {
      client.getState.mockResolvedValue('CONNECTED')

      expect(await service.state('main')).toEqual({ state: 'CONNECTED' })
    })

    it('reads the WhatsApp Web version of a ready session', async () => {
      client.getWWebVersion.mockResolvedValue('2.3000.1')

      expect(await service.webVersion('main')).toEqual({ version: '2.3000.1' })
    })

    it('reads the account of a ready session', async () => {
      client.getClientInfo.mockResolvedValue({ wid: 'w' })

      expect(await service.info('main')).toEqual({ wid: 'w' })
    })

    it('refuses a session that is not ready, without calling the client', async () => {
      const notReady = new Error('not ready')
      manager.requireReady.mockImplementation(() => {
        throw notReady
      })

      await expect(service.state('main')).rejects.toBe(notReady)
      await expect(service.webVersion('main')).rejects.toBe(notReady)
      await expect(service.info('main')).rejects.toBe(notReady)
      expect(client.getState).not.toHaveBeenCalled()
    })

    it('lets the failure of the client through', async () => {
      const failure = new Error('page crashed')
      client.getState.mockRejectedValue(failure)

      await expect(service.state('main')).rejects.toBe(failure)
    })

    it('resets the state through the manager', async () => {
      manager.resetState.mockResolvedValue(undefined)

      await service.resetState('main')

      expect(manager.resetState).toHaveBeenCalledWith('main')
    })
  })
})
