import { Inject, Injectable } from '@nestjs/common'
import { toBuffer } from 'qrcode'
import { z } from 'zod'

import { NotFoundError } from '../common/errors.js'
import type { Session } from '../database/models.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { ClientInfoDto } from '../types/dto.js'
import type {
  CreateSessionDto,
  SessionDto,
  SessionListDto,
  SessionQrDto,
  SessionStateDto,
  SessionWebVersionDto,
  UpdateSessionDto
} from '../types/sessions.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

// Pixels per module and quiet zone of the PNG: large enough for a phone to scan from a monitor
const QR_PNG_SCALE = 8
const QR_PNG_MARGIN = 2

const SettingsRecord = z.record(z.string(), z.json())

// `seqHighWater` is a bigint that belongs to the event pipeline: it never leaves the gateway
export function toSessionDto(row: Session): SessionDto {
  const settings = SettingsRecord.safeParse(row.settings)
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    phoneNumber: row.phoneNumber,
    pushName: row.pushName,
    autoStart: row.autoStart,
    settings: settings.success ? settings.data : {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    linkedAt: row.linkedAt?.toISOString() ?? null,
    lastError: row.lastError
  }
}

const sessionNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Session ${id} does not exist`)

@Injectable()
export class SessionsService {
  constructor(
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(SessionManager) private readonly manager: SessionManager
  ) {}

  async list(): Promise<SessionListDto> {
    return { sessions: (await this.sessions.list()).map(toSessionDto) }
  }

  async get(id: string): Promise<SessionDto> {
    const row = await this.sessions.findById(id)
    if (row === null) throw sessionNotFound(id)
    return toSessionDto(row)
  }

  async create({ id, ...options }: CreateSessionDto): Promise<SessionDto> {
    return toSessionDto(await this.manager.create(id, options))
  }

  async update(id: string, { settings, ...patch }: UpdateSessionDto): Promise<SessionDto> {
    // The merge is its own statement: reading the row, merging here and writing it back would lose
    // the keys another request wrote in between
    if (settings && !(await this.sessions.mergeSettings(id, settings))) throw sessionNotFound(id)
    const updated =
      Object.keys(patch).length > 0
        ? await this.sessions.update(id, patch)
        : await this.sessions.findById(id)
    if (updated === null) throw sessionNotFound(id)
    return toSessionDto(updated)
  }

  async start(id: string): Promise<SessionDto> {
    return toSessionDto(await this.manager.start(id))
  }

  async stop(id: string): Promise<SessionDto> {
    return toSessionDto(await this.manager.stop(id))
  }

  async restart(id: string): Promise<SessionDto> {
    return toSessionDto(await this.manager.restart(id))
  }

  async logout(id: string): Promise<SessionDto> {
    return toSessionDto(await this.manager.logout(id))
  }

  remove(id: string): Promise<void> {
    return this.manager.remove(id)
  }

  async resetState(id: string): Promise<void> {
    await this.manager.resetState(id)
  }

  qr(id: string): SessionQrDto {
    const qr = this.requireQr(id)
    return { qr, status: this.manager.status(id) }
  }

  async qrPng(id: string): Promise<Buffer> {
    return toBuffer(this.requireQr(id), { scale: QR_PNG_SCALE, margin: QR_PNG_MARGIN })
  }

  async state(id: string): Promise<SessionStateDto> {
    return { state: await this.manager.requireReady(id).getState() }
  }

  async webVersion(id: string): Promise<SessionWebVersionDto> {
    return { version: await this.manager.requireReady(id).getWWebVersion() }
  }

  async info(id: string): Promise<ClientInfoDto> {
    return this.manager.requireReady(id).getClientInfo()
  }

  private requireQr(id: string): string {
    const qr = this.manager.qr(id)
    if (qr === undefined) {
      throw new NotFoundError(
        'NOT_FOUND',
        `Session ${id} has no QR code to scan (status ${this.manager.status(id)})`
      )
    }
    return qr
  }
}
