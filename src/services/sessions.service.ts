import { Inject, Injectable, Logger } from '@nestjs/common'
import { toBuffer } from 'qrcode'
import { z } from 'zod'

import { NotFoundError, WhatsAppError } from '../common/errors.js'
import type { Session } from '../database/models.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { BatteryInfoDto } from '../types/dto.js'
import type {
  CreateSessionDto,
  PairingCodeBodyDto,
  PairingCodeResponseDto,
  SessionClientInfoDto,
  SessionDto,
  SessionListDto,
  SessionQrDto,
  SessionStateDto,
  SessionWebVersionDto,
  UpdateSessionDto
} from '../types/sessions.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { AuthService } from './auth.service.js'
import { WebhookService } from './webhook.service.js'

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
  private readonly logger = new Logger(SessionsService.name)

  constructor(
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(SessionManager) private readonly manager: SessionManager,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WebhookService) private readonly webhooks: WebhookService
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

  // The keys and the webhooks of the session are deleted with it; the caches of the guard and of the
  // dispatcher must forget them now, also when a later step of the deletion fails, because the rows
  // are already gone by then. A session created again under the same id must not inherit them.
  async remove(id: string): Promise<void> {
    try {
      await this.manager.remove(id)
    } finally {
      this.auth.invalidateSession(id)
      this.webhooks.invalidate()
    }
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

  // The battery is read apart: a linked device often cannot give it, and that must not hide the
  // account. Only a failure of WhatsApp Web is left out; anything else is a real error.
  async info(id: string): Promise<SessionClientInfoDto> {
    const client = this.manager.requireReady(id)
    const info = await client.getClientInfo()
    try {
      // A linked device can answer with empty values instead of failing
      const battery = BatteryInfoDto.safeParse(await client.getBatteryStatus())
      return battery.success ? { ...info, battery: battery.data } : info
    } catch (error: unknown) {
      if (!(error instanceof WhatsAppError)) throw error
      this.logger.debug(`[${id}] the battery could not be read (${error.code})`)
      return info
    }
  }

  // Asked while the session waits to be linked: a code instead of the QR. A new request replaces
  // the pending code. The code is a credential for the account, so it is never logged.
  async requestPairingCode(id: string, body: PairingCodeBodyDto): Promise<PairingCodeResponseDto> {
    const client = this.manager.requireLinking(id, 'qr', 'pairing_code')
    return {
      code: await client.requestPairingCode({
        phoneNumber: body.phoneNumber,
        ...(body.showNotification === undefined ? {} : { showNotification: body.showNotification })
      })
    }
  }

  // Goes back to the QR code. The `code` event may not have moved the status yet when the caller
  // cancels the code it just received, so `qr` is accepted too.
  async cancelPairingCode(id: string): Promise<void> {
    await this.manager.requireLinking(id, 'qr', 'pairing_code').cancelPairingCode()
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
