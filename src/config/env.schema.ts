import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development')
    .describe('Runtime mode'),
  HOST: z.string().min(1).default('0.0.0.0').describe('Interface the HTTP server binds to'),
  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3000)
    .describe('Port the HTTP server listens on'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info')
    .describe('Minimum level written by the logger'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).describe('PostgreSQL connection string'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).describe('Redis connection string'),
  ADMIN_API_KEY: z
    .string()
    .trim()
    .min(32)
    .describe('Admin API key, 32 characters or more (stored only as a hash)'),
  METRICS_TOKEN: z
    .string()
    .trim()
    .min(1)
    .describe('Bearer token that grants access to GET /metrics')
})
