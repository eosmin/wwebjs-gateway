import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { SessionStatus } from './dto.js'

// The public part of a Terminus result. A failed indicator also carries the message of the error,
// which can name hosts, ports and users: the schema drops it, so it never reaches an anonymous caller.
const indicator = z.object({
  status: z.enum(['up', 'down', 'degraded']),
  responseTime: z.number().optional()
})
const indicators = z.record(z.string(), indicator)

export const HealthResult = z.object({
  status: z.enum(['ok', 'degraded', 'error', 'shutting_down']),
  info: indicators.optional().describe('The indicators that are up'),
  error: indicators.optional().describe('The indicators that are down'),
  details: indicators.describe('Every indicator')
})
export class HealthResultDto extends createZodDto(HealthResult) {}

export const SystemInfo = z.object({
  gatewayVersion: z.string(),
  wwebjsVersion: z.string(),
  nodeVersion: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  sessions: z.object({
    total: z.number().int().nonnegative(),
    byStatus: z
      .record(z.string(), z.number().int().nonnegative())
      .describe('Session count for every status, zero included'),
    items: z.array(
      z.object({
        id: z.string(),
        status: SessionStatus,
        wwebVersion: z
          .string()
          .nullable()
          .describe('Version of WhatsApp Web the session runs; null unless it is ready')
      })
    )
  })
})
export class SystemInfoDto extends createZodDto(SystemInfo) {}
