import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  StreamableFile
} from '@nestjs/common'
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger'
import { ZodResponse } from 'nestjs-zod'

import { SessionsService } from '../../services/sessions.service.js'
import { ClientInfoDto } from '../../types/dto.js'
import {
  CreateSessionDto,
  SessionClientInfoDto,
  SessionDto,
  SessionIdParamsDto,
  SessionListDto,
  SessionQrDto,
  SessionStateDto,
  SessionWebVersionDto,
  UpdateSessionDto
} from '../../types/sessions.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const SESSION_EXAMPLE = {
  id: 'support-line',
  name: 'Support line',
  status: 'ready',
  phoneNumber: '5215500000001',
  pushName: 'Support',
  autoStart: true,
  settings: { ordering: { enabled: true } },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:05:00.000Z',
  lastConnectedAt: '2026-01-01T00:05:00.000Z',
  lastEventAt: '2026-01-01T00:06:00.000Z',
  linkedAt: '2026-01-01T00:05:00.000Z',
  lastError: null
}

// Session routes (everything with a :sessionId) are limited to the session of a session key by the
// ApiKeyGuard; the list and the creation touch every session, so only admin keys reach them
@Controller('v1/sessions')
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Post()
  @ZodResponse({ status: HttpStatus.CREATED, type: SessionDto })
  @WaOperation({
    id: 'sessions.create',
    scope: 'admin',
    summary: 'Create a session',
    description:
      'Registers the session as `created`; nothing runs until it is started. Fails when the id exists or MAX_SESSIONS sessions are registered.',
    errors: [
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'INSUFFICIENT_SCOPE',
      'SESSION_ALREADY_EXISTS',
      'MAX_SESSIONS_REACHED'
    ],
    examples: {
      request: { id: 'support-line', name: 'Support line' },
      response: { ...SESSION_EXAMPLE, status: 'created', phoneNumber: null, pushName: null }
    },
    wwebjs: [],
    gateway: true
  })
  create(@Body() body: CreateSessionDto): Promise<SessionDto> {
    return this.sessions.create(body)
  }

  @Get()
  @ZodResponse({ type: SessionListDto })
  @WaOperation({
    id: 'sessions.list',
    scope: 'admin',
    summary: 'List the sessions',
    description: 'Every session of the gateway, running or not, oldest first.',
    errors: ['UNAUTHORIZED', 'INSUFFICIENT_SCOPE'],
    examples: { request: null, response: { sessions: [SESSION_EXAMPLE] } },
    wwebjs: [],
    gateway: true
  })
  list(): Promise<SessionListDto> {
    return this.sessions.list()
  }

  @Get(':sessionId')
  @ZodResponse({ type: SessionDto })
  @WaOperation({
    id: 'sessions.get',
    scope: 'read',
    summary: 'Read a session',
    description: 'The configuration and the current status of the session.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: { request: null, response: SESSION_EXAMPLE },
    wwebjs: [],
    gateway: true
  })
  get(@Param() { sessionId }: SessionIdParamsDto): Promise<SessionDto> {
    return this.sessions.get(sessionId)
  }

  @Patch(':sessionId')
  @ZodResponse({ type: SessionDto })
  @WaOperation({
    id: 'sessions.update',
    scope: 'manage',
    summary: 'Update a session',
    description:
      'Changes the name, whether the session starts at boot, and its settings. It does not restart the session: a running one reads the new settings at its next start.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: {
      request: { name: 'Support line', settings: { ordering: { enabled: false } } },
      response: SESSION_EXAMPLE
    },
    wwebjs: [],
    gateway: true
  })
  update(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() body: UpdateSessionDto
  ): Promise<SessionDto> {
    return this.sessions.update(sessionId, body)
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'sessions.remove',
    scope: 'manage',
    summary: 'Delete a session',
    description:
      'Logs the account out when it is running, then deletes the session with its API keys, webhooks, inbound hooks and stored messages. It cannot be undone.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: { request: null, response: null },
    wwebjs: ['Client.logout', 'Client.destroy']
  })
  remove(@Param() { sessionId }: SessionIdParamsDto): Promise<void> {
    return this.sessions.remove(sessionId)
  }

  @Post(':sessionId/start')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: SessionDto })
  @WaOperation({
    id: 'sessions.start',
    scope: 'manage',
    summary: 'Start a session',
    description:
      'Launches the browser and logs in: with the saved login when there is one, or by asking for a QR code. A session that already runs is left as it is. Starting also makes the session start at every boot.',
    errors: [
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'MAX_SESSIONS_REACHED'
    ],
    examples: { request: null, response: { ...SESSION_EXAMPLE, status: 'starting' } },
    wwebjs: ['Client.initialize']
  })
  start(@Param() { sessionId }: SessionIdParamsDto): Promise<SessionDto> {
    return this.sessions.start(sessionId)
  }

  @Post(':sessionId/stop')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: SessionDto })
  @WaOperation({
    id: 'sessions.stop',
    scope: 'manage',
    summary: 'Stop a session',
    description:
      'Closes the browser without logging out, so the next start needs no QR code. The session stops starting at boot until it is started again.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: {
      request: null,
      response: { ...SESSION_EXAMPLE, status: 'stopped', autoStart: false }
    },
    wwebjs: ['Client.destroy']
  })
  stop(@Param() { sessionId }: SessionIdParamsDto): Promise<SessionDto> {
    return this.sessions.stop(sessionId)
  }

  @Post(':sessionId/restart')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: SessionDto })
  @WaOperation({
    id: 'sessions.restart',
    scope: 'manage',
    summary: 'Restart a session',
    description: 'Stops and starts the session again, keeping whether it starts at boot.',
    errors: [
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'MAX_SESSIONS_REACHED'
    ],
    examples: { request: null, response: { ...SESSION_EXAMPLE, status: 'starting' } },
    wwebjs: ['Client.destroy', 'Client.initialize']
  })
  restart(@Param() { sessionId }: SessionIdParamsDto): Promise<SessionDto> {
    return this.sessions.restart(sessionId)
  }

  @Post(':sessionId/logout')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: SessionDto })
  @WaOperation({
    id: 'sessions.logout',
    scope: 'manage',
    summary: 'Log a session out',
    description:
      'Unlinks the account from this device. The session goes back to `created` and needs a new QR code to be started.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: {
      request: null,
      response: { ...SESSION_EXAMPLE, status: 'created', phoneNumber: null, autoStart: false }
    },
    wwebjs: ['Client.logout']
  })
  logout(@Param() { sessionId }: SessionIdParamsDto): Promise<SessionDto> {
    return this.sessions.logout(sessionId)
  }

  @Post(':sessionId/reset-state')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'sessions.resetState',
    scope: 'manage',
    summary: 'Reset the state of WhatsApp Web',
    description: 'Asks WhatsApp Web to reset its connection state. The session must be ready.',
    errors: [
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'SESSION_NOT_READY',
      'WHATSAPP_ERROR',
      'WHATSAPP_TIMEOUT'
    ],
    examples: { request: null, response: null },
    wwebjs: ['Client.resetState']
  })
  resetState(@Param() { sessionId }: SessionIdParamsDto): Promise<void> {
    return this.sessions.resetState(sessionId)
  }

  @Get(':sessionId/qr')
  @Header('Cache-Control', 'no-store')
  @ZodResponse({ type: SessionQrDto })
  @WaOperation({
    id: 'sessions.qr',
    scope: 'manage',
    summary: 'Read the QR code of a session',
    description:
      'The text of the QR code the session waits to be scanned. It is kept in memory only and WhatsApp renews it every few seconds, so read it again to get the current one. Answers 404 when the session shows no QR code. Needs the `manage` scope, not `read`: whoever scans the code links their own device to the account.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: { request: null, response: { qr: '2@EXAMPLEEXAMPLEEXAMPLE', status: 'qr' } },
    wwebjs: [],
    gateway: true
  })
  qr(@Param() { sessionId }: SessionIdParamsDto): SessionQrDto {
    return this.sessions.qr(sessionId)
  }

  @Get(':sessionId/qr.png')
  @Header('Cache-Control', 'no-store')
  @ApiProduces('image/png')
  @ApiOkResponse({
    description: 'The QR code as a PNG image',
    schema: { type: 'string', format: 'binary' }
  })
  @WaOperation({
    id: 'sessions.qrPng',
    scope: 'manage',
    summary: 'Read the QR code of a session as an image',
    description:
      'The same QR code as `GET …/qr`, rendered as a PNG that can be shown or scanned from a screen. Answers 404 when the session shows no QR code. Needs the `manage` scope, not `read`: whoever scans the code links their own device to the account.',
    errors: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'],
    examples: { request: null, response: null },
    wwebjs: [],
    gateway: true
  })
  // The type travels with the file, so an error keeps its JSON content type
  async qrPng(@Param() { sessionId }: SessionIdParamsDto): Promise<StreamableFile> {
    return new StreamableFile(await this.sessions.qrPng(sessionId), { type: 'image/png' })
  }

  @Get(':sessionId/state')
  @ZodResponse({ type: SessionStateDto })
  @WaOperation({
    id: 'sessions.state',
    scope: 'read',
    summary: 'Read the connection state of WhatsApp Web',
    description: 'The state WhatsApp Web reports, such as CONNECTED. The session must be ready.',
    errors: [
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'SESSION_NOT_READY',
      'WHATSAPP_ERROR',
      'WHATSAPP_TIMEOUT'
    ],
    examples: { request: null, response: { state: 'CONNECTED' } },
    wwebjs: ['Client.getState']
  })
  state(@Param() { sessionId }: SessionIdParamsDto): Promise<SessionStateDto> {
    return this.sessions.state(sessionId)
  }

  @Get(':sessionId/wweb-version')
  @ZodResponse({ type: SessionWebVersionDto })
  @WaOperation({
    id: 'sessions.webVersion',
    scope: 'read',
    summary: 'Read the version of WhatsApp Web',
    description: 'The version of WhatsApp Web the session runs. The session must be ready.',
    errors: [
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'SESSION_NOT_READY',
      'WHATSAPP_ERROR',
      'WHATSAPP_TIMEOUT'
    ],
    examples: { request: null, response: { version: '2.3000.1000000000' } },
    wwebjs: ['Client.getWWebVersion']
  })
  webVersion(@Param() { sessionId }: SessionIdParamsDto): Promise<SessionWebVersionDto> {
    return this.sessions.webVersion(sessionId)
  }

  @Get(':sessionId/info')
  @ZodResponse({ type: SessionClientInfoDto })
  @WaOperation({
    id: 'sessions.info',
    scope: 'read',
    summary: 'Read the account linked to a session',
    description: 'The id, name and platform of the linked account. The session must be ready.',
    errors: [
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'SESSION_NOT_READY',
      'WHATSAPP_ERROR',
      'WHATSAPP_TIMEOUT'
    ],
    examples: {
      request: null,
      response: {
        wid: '5215500000001@c.us',
        me: '5215500000001@c.us',
        platform: 'android',
        pushname: 'Support'
      }
    },
    wwebjs: ['Client.info']
  })
  info(@Param() { sessionId }: SessionIdParamsDto): Promise<ClientInfoDto> {
    return this.sessions.info(sessionId)
  }
}
