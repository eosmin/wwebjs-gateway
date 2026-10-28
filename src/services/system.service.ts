import { Inject, Injectable } from '@nestjs/common'

import { type PackageInfo, readPackageInfo } from '../common/lib/package-info.js'
import type { Session } from '../database/models.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { SESSION_STATUSES } from '../types/dto.js'
import type { SystemInfoDto } from '../types/system.dto.js'
import { type RunningSession, SessionManager } from '../whatsapp/session-manager.service.js'

@Injectable()
export class SystemService {
  private readonly packageInfo: PackageInfo = readPackageInfo()

  constructor(
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(SessionManager) private readonly manager: SessionManager
  ) {}

  async info(): Promise<SystemInfoDto> {
    const rows = await this.sessions.list()
    const running = this.manager.running()
    const items = await Promise.all(rows.map(row => this.describe(row, running)))
    // Counted from the statuses `items` reports, so one answer never contradicts itself
    const byStatus = Object.fromEntries(
      SESSION_STATUSES.map(status => [status, items.filter(item => item.status === status).length])
    )
    return {
      gatewayVersion: this.packageInfo.gatewayVersion,
      wwebjsVersion: this.packageInfo.wwebjsVersion,
      nodeVersion: process.versions.node,
      uptimeSeconds: Math.floor(process.uptime()),
      sessions: {
        total: items.length,
        byStatus,
        items
      }
    }
  }

  // The status of a session that runs is the one in memory, the single place it is read; the row
  // can be a moment behind. A page that does not answer must not fail the whole report, so the
  // version is just missing.
  private async describe(
    row: Session,
    running: RunningSession[]
  ): Promise<SystemInfoDto['sessions']['items'][number]> {
    const run = running.find(candidate => candidate.id === row.id)
    const status = run?.status ?? row.status
    if (run?.status !== 'ready') return { id: row.id, status, wwebVersion: null }
    try {
      return { id: row.id, status, wwebVersion: await run.client.getWWebVersion() }
    } catch {
      return { id: row.id, status, wwebVersion: null }
    }
  }
}
