import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { isValidCidr } from '../common/lib/cidr.js'
import { KEY_SCOPES } from '../common/principal.js'

const isoDate = z.iso.datetime()

// An allowlist is a handful of proxies and offices; the bound keeps one request from storing a huge row
const MAX_ALLOWED_CIDRS = 64

export const ApiKeyIdParams = z.strictObject({ id: z.uuid().describe('Id of the API key') })
export class ApiKeyIdParamsDto extends createZodDto(ApiKeyIdParams) {}

export const CreateApiKeyBody = z.strictObject({
  name: z.string().trim().min(1).max(100).describe('Label that tells the key apart in listings'),
  sessionId: z
    .string()
    .regex(/^[-_\w]{1,64}$/)
    .optional()
    .describe('Session the key is limited to; omit it for an admin key'),
  scopes: z
    .array(z.enum(KEY_SCOPES))
    .min(1)
    .max(KEY_SCOPES.length)
    .optional()
    .describe('Permissions of a session key; defaults to read, send and events'),
  allowedCidrs: z
    .array(z.string().refine(isValidCidr, 'not an IP address or CIDR range'))
    .max(MAX_ALLOWED_CIDRS)
    .optional()
    .describe('Addresses the key may be used from; empty means any'),
  expiresAt: isoDate
    .optional()
    .describe(
      'When the key stops working; defaults to the longest lifetime allowed (never when API_KEY_MAX_TTL_DAYS is 0)'
    )
})
export class CreateApiKeyDto extends createZodDto(CreateApiKeyBody) {}

const apiKeyShape = {
  id: z.uuid(),
  name: z.string(),
  keyPrefix: z.string().describe('First characters of the key, to recognise it'),
  sessionId: z.string().nullable().describe('Null for an admin key'),
  scopes: z.array(z.string()),
  allowedCidrs: z.array(z.string()),
  expiresAt: isoDate.nullable(),
  rotatedFromId: z.uuid().nullable().describe('The key this one replaced'),
  createdAt: isoDate,
  lastUsedAt: isoDate.nullable(),
  revokedAt: isoDate.nullable()
}

export const ApiKey = z.object(apiKeyShape)
export class ApiKeyDto extends createZodDto(ApiKey) {}

export const ApiKeyList = z.object({ keys: z.array(ApiKey) })
export class ApiKeyListDto extends createZodDto(ApiKeyList) {}

const secret = z.string().describe('The raw key; shown once and never stored')

export const CreatedApiKey = z.object({ ...apiKeyShape, key: secret })
export class CreatedApiKeyDto extends createZodDto(CreatedApiKey) {}

export const RotatedApiKey = z.object({
  ...apiKeyShape,
  key: secret,
  previousKeyExpiresAt: isoDate.describe('When the replaced key stops working')
})
export class RotatedApiKeyDto extends createZodDto(RotatedApiKey) {}
