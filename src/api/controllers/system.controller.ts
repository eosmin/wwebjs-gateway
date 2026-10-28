import { Controller, Get, Inject } from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import { SystemService } from '../../services/system.service.js'
import { SystemInfoDto } from '../../types/system.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

@Controller('v1/system')
export class SystemController {
  constructor(@Inject(SystemService) private readonly system: SystemService) {}

  @Get('info')
  @ZodResponse({ type: SystemInfoDto })
  @WaOperation({
    id: 'system.info',
    scope: 'admin',
    summary: 'Read the gateway version and the session counts',
    description:
      'Versions of the gateway, whatsapp-web.js and Node, the uptime of the process, how many sessions are in each status, and the status and WhatsApp Web version of each session.',
    errors: ['UNAUTHORIZED', 'INSUFFICIENT_SCOPE'],
    examples: {
      request: null,
      response: {
        gatewayVersion: '0.0.0',
        wwebjsVersion: '1.34.7',
        nodeVersion: '24.20.0',
        uptimeSeconds: 3600,
        sessions: {
          total: 2,
          byStatus: { ready: 1, qr: 1 },
          items: [
            { id: 'support-line', status: 'ready', wwebVersion: '2.3000.1000000000' },
            { id: 'sales', status: 'qr', wwebVersion: null }
          ]
        }
      }
    },
    wwebjs: [],
    gateway: true
  })
  info(): Promise<SystemInfoDto> {
    return this.system.info()
  }
}
