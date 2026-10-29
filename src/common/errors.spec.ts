import { HttpStatus } from '@nestjs/common'

import {
  AppError,
  ConflictError,
  ERROR_DEFINITIONS,
  ErrorCode,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableError,
  ValidationError,
  WhatsAppError
} from './errors.js'

describe('ERROR_DEFINITIONS', () => {
  it('defines every code, with a meaning that fits a markdown table cell', () => {
    expect(Object.keys(ERROR_DEFINITIONS).sort()).toEqual(Object.values(ErrorCode).sort())
    for (const { meaning } of Object.values(ERROR_DEFINITIONS)) {
      expect(meaning).toMatch(/^[^|\n]+\.$/)
    }
  })

  // The statuses the TDD states (§6.2, §6.5, §6.8, §6.11); the rest of the codes are pinned by the
  // subclass table below
  it.each([
    ['VALIDATION_ERROR', 400],
    ['UNAUTHORIZED', 401],
    ['API_KEY_EXPIRED', 401],
    ['FORBIDDEN', 403],
    ['INSUFFICIENT_SCOPE', 403],
    ['IP_NOT_ALLOWED', 403],
    ['RATE_LIMITED', 429],
    ['SESSION_NOT_READY', 409],
    ['IDEMPOTENCY_KEY_REUSED', 422],
    ['NUMBER_NOT_ON_WHATSAPP', 422],
    ['POLICY_BLOCKED', 422],
    ['WHATSAPP_ERROR', 502],
    ['WHATSAPP_TIMEOUT', 504],
    ['INTERNAL', 500]
  ] as const)('%s answers %d', (code, status) => {
    expect(ERROR_DEFINITIONS[code].status).toBe(status)
  })
})

describe('AppError', () => {
  it('takes its status from the code, and its message from the meaning by default', () => {
    const error = new AppError('CHAT_NOT_FOUND')

    expect(error.code).toBe('CHAT_NOT_FOUND')
    expect(error.status).toBe(HttpStatus.NOT_FOUND)
    expect(error.message).toBe(ERROR_DEFINITIONS.CHAT_NOT_FOUND.meaning)
    expect(error.details).toBeUndefined()
  })

  it('keeps the message and the details it is given', () => {
    const error = new AppError('POLICY_BLOCKED', 'cold sends are off', { rule: 'cold_send' })

    expect(error.message).toBe('cold sends are off')
    expect(error.details).toEqual({ rule: 'cold_send' })
  })

  it('keeps an empty message and empty details as they are given', () => {
    const error = new AppError('INTERNAL', '', {})

    expect(error.message).toBe('')
    expect(error.details).toEqual({})
  })
})

describe('the subclasses', () => {
  it.each([
    ['ValidationError', new ValidationError('VALIDATION_ERROR'), 'VALIDATION_ERROR', 400],
    ['UnauthorizedError', new UnauthorizedError('API_KEY_EXPIRED'), 'API_KEY_EXPIRED', 401],
    ['ForbiddenError', new ForbiddenError('INSUFFICIENT_SCOPE'), 'INSUFFICIENT_SCOPE', 403],
    ['NotFoundError', new NotFoundError('NOT_FOUND'), 'NOT_FOUND', 404],
    ['ConflictError', new ConflictError('MAX_SESSIONS_REACHED'), 'MAX_SESSIONS_REACHED', 409],
    [
      'UnprocessableError',
      new UnprocessableError('IDEMPOTENCY_KEY_REUSED'),
      'IDEMPOTENCY_KEY_REUSED',
      422
    ],
    ['WhatsAppError', new WhatsAppError('WHATSAPP_ERROR'), 'WHATSAPP_ERROR', 502],
    ['WhatsAppError', new WhatsAppError('WHATSAPP_TIMEOUT'), 'WHATSAPP_TIMEOUT', 504],
    ['InternalError', new InternalError('INTERNAL'), 'INTERNAL', 500]
  ])('%s(%s)', (name, error, code, status) => {
    expect(error).toBeInstanceOf(AppError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(name)
    expect(error.code).toBe(code)
    expect(error.status).toBe(status)
  })

  // Each line must keep failing to compile: an unused directive is an error in the type-check
  it('only accepts the codes of its status', () => {
    const rejected = [
      // @ts-expect-error: a 404 is not a 400
      () => new ValidationError('NOT_FOUND'),
      // @ts-expect-error: a 409 is not a 401
      () => new UnauthorizedError('SESSION_NOT_READY'),
      // @ts-expect-error: a 401 is not a 403
      () => new ForbiddenError('UNAUTHORIZED'),
      // @ts-expect-error: a 409 is not a 404
      () => new NotFoundError('SESSION_NOT_READY'),
      // @ts-expect-error: a 404 is not a 409
      () => new ConflictError('NOT_FOUND'),
      // @ts-expect-error: a 409 is not a 422
      () => new UnprocessableError('SESSION_NOT_READY'),
      // @ts-expect-error: a 409 is not a 502 or a 504
      () => new WhatsAppError('SESSION_NOT_READY'),
      // @ts-expect-error: a 502 is not a 500
      () => new InternalError('WHATSAPP_ERROR')
    ]

    expect(rejected).toHaveLength(8)
  })
})
