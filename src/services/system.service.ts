import { Inject, Injectable } from '@nestjs/common'

import { type PackageInfo, readPackageInfo } from '../common/lib/package-info.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { SESSION_STATUSES } from '../types/dto.js'
import type { SystemInfoDto } from '../types/system.dto.js'

@Injectable()
export class SystemService {
  private readonly packageInfo: PackageInfo = readPackageInfo()

  constructor(@Inject(SessionsRepository) private readonly sessions: SessionsRepository) {}

  async info(): Promise<SystemInfoDto> {
    const rows = await this.sessions.list()
    const byStatus = Object.fromEntries(
      SESSION_STATUSES.map(status => [status, rows.filter(row => row.status === status).length])
    )
    return {
      gatewayVersion: this.packageInfo.gatewayVersion,
      wwebjsVersion: this.packageInfo.wwebjsVersion,
      nodeVersion: process.versions.node,
      uptimeSeconds: Math.floor(process.uptime()),
      sessions: { total: rows.length, byStatus }
    }
  }
}
