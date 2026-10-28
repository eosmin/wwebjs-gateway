import { Body, Controller, Delete, Get, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import { ApiKeysService } from '../../services/api-keys.service.js'
import {
  ApiKeyDto,
  ApiKeyIdParamsDto,
  ApiKeyListDto,
  CreateApiKeyDto,
  CreatedApiKeyDto,
  RotatedApiKeyDto
} from '../../types/api-keys.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const KEY_EXAMPLE = {
  id: '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10',
  name: 'chatbot',
  keyPrefix: 'wgk_Ab3d',
  sessionId: 'main',
  scopes: ['read', 'send', 'events'],
  allowedCidrs: [],
  expiresAt: null,
  rotatedFromId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null
}

// Only admin keys manage keys: every operation is `admin`, a scope no key can be granted
@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly apiKeys: ApiKeysService) {}

  @Post()
  @ZodResponse({ status: HttpStatus.CREATED, type: CreatedApiKeyDto })
  @WaOperation({
    id: 'apiKeys.create',
    scope: 'admin',
    summary: 'Create an API key',
    description:
      'Without sessionId the key is an admin key. The raw key is in this answer only: the gateway keeps its hash.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: {
      request: { name: 'chatbot', sessionId: 'main', scopes: ['read', 'send', 'events'] },
      response: { ...KEY_EXAMPLE, key: 'wgk_Ab3dEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE000' }
    },
    wwebjs: [],
    gateway: true
  })
  create(@Body() body: CreateApiKeyDto): Promise<CreatedApiKeyDto> {
    return this.apiKeys.create(body)
  }

  @Get()
  @ZodResponse({ type: ApiKeyListDto })
  @WaOperation({
    id: 'apiKeys.list',
    scope: 'admin',
    summary: 'List the API keys',
    description: 'Every key, revoked and expired ones included. The raw keys are never returned.',
    errors: ['UNAUTHORIZED', 'INSUFFICIENT_SCOPE'],
    examples: { request: null, response: { keys: [KEY_EXAMPLE] } },
    wwebjs: [],
    gateway: true
  })
  async list(): Promise<ApiKeyListDto> {
    return { keys: await this.apiKeys.list() }
  }

  @Post(':id/rotate')
  @ZodResponse({ status: HttpStatus.CREATED, type: RotatedApiKeyDto })
  @WaOperation({
    id: 'apiKeys.rotate',
    scope: 'admin',
    summary: 'Rotate an API key',
    description:
      'Issues a key with the same name, session, scopes and addresses, and lets the old one work for API_KEY_ROTATION_GRACE_MINUTES more, so the consumer swaps the secret without downtime.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: {
      request: null,
      response: {
        ...KEY_EXAMPLE,
        rotatedFromId: '3b9a1c0e-6d2f-4f7e-8a41-5e0d7c9b1a22',
        key: 'wgk_Zx9yEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE111',
        previousKeyExpiresAt: '2026-01-01T00:10:00.000Z'
      }
    },
    wwebjs: [],
    gateway: true
  })
  rotate(@Param() params: ApiKeyIdParamsDto): Promise<RotatedApiKeyDto> {
    return this.apiKeys.rotate(params.id)
  }

  @Delete(':id')
  @ZodResponse({ type: ApiKeyDto })
  @WaOperation({
    id: 'apiKeys.revoke',
    scope: 'admin',
    summary: 'Revoke an API key',
    description:
      'The key stops working at once on this instance. Revoking a revoked key keeps the first date.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: {
      request: null,
      response: { ...KEY_EXAMPLE, revokedAt: '2026-01-02T00:00:00.000Z' }
    },
    wwebjs: [],
    gateway: true
  })
  revoke(@Param() params: ApiKeyIdParamsDto): Promise<ApiKeyDto> {
    return this.apiKeys.revoke(params.id)
  }
}
