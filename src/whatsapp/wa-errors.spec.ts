import { HttpStatus } from '@nestjs/common'

import { AppError, ConflictError, WhatsAppError } from '../common/errors.js'

import { WaDisconnectedError, WaOperationError, WaTimeoutError } from './wa-errors.js'

describe('wa-errors', () => {
  it('maps a lost browser to SESSION_NOT_READY (409)', () => {
    const error = new WaDisconnectedError('sendMessage', false)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('WaDisconnectedError')
    expect(error.code).toBe('SESSION_NOT_READY')
    expect(error.status).toBe(HttpStatus.CONFLICT)
    expect(error.operation).toBe('sendMessage')
    expect(error.dispatched).toBe(false)
    expect(error.details).toEqual({ operation: 'sendMessage', dispatched: false })
  })

  it('says when the browser died with the call in flight, so that it is not retried', () => {
    const error = new WaDisconnectedError('sendMessage', true)

    expect(error.dispatched).toBe(true)
    expect(error.details).toEqual({ operation: 'sendMessage', dispatched: true })
  })

  it('maps a timeout to WHATSAPP_TIMEOUT (504) and says whether the call was dispatched', () => {
    const dispatched = new WaTimeoutError('sendMessage', true)
    const notDispatched = new WaTimeoutError('getChats', false)

    expect(dispatched).toBeInstanceOf(WhatsAppError)
    expect(dispatched.name).toBe('WaTimeoutError')
    expect(dispatched.code).toBe('WHATSAPP_TIMEOUT')
    expect(dispatched.status).toBe(HttpStatus.GATEWAY_TIMEOUT)
    expect(dispatched.dispatched).toBe(true)
    expect(dispatched.details).toEqual({ operation: 'sendMessage', dispatched: true })
    expect(notDispatched.dispatched).toBe(false)
    expect(notDispatched.details).toEqual({ operation: 'getChats', dispatched: false })
  })

  it('maps a failed call to WHATSAPP_ERROR (502)', () => {
    const error = new WaOperationError('getChatById', 'chat not found')

    expect(error).toBeInstanceOf(WhatsAppError)
    expect(error.name).toBe('WaOperationError')
    expect(error.code).toBe('WHATSAPP_ERROR')
    expect(error.status).toBe(HttpStatus.BAD_GATEWAY)
    expect(error.message).toBe('chat not found')
    expect(error.operation).toBe('getChatById')
    expect(error.details).toEqual({ operation: 'getChatById' })
  })

  it('falls back to the meaning of the code and accepts a custom message', () => {
    expect(new WaDisconnectedError('x', false).message).toMatch(/not ready|connected/i)
    expect(new WaTimeoutError('x', false).message).toContain('WA_CALL_TIMEOUT_MS')
    expect(new WaOperationError('x').message).toMatch(/failed/i)
    expect(new WaDisconnectedError('x', true, 'browser closed').message).toBe('browser closed')
    expect(new WaTimeoutError('x', true, 'too slow').message).toBe('too slow')
  })

  it('tells the three classes apart, since the send worker branches on it', () => {
    const timeout = new WaTimeoutError('x', true)

    expect(timeout).not.toBeInstanceOf(WaOperationError)
    expect(timeout).not.toBeInstanceOf(WaDisconnectedError)
    expect(new WaOperationError('x')).not.toBeInstanceOf(WaTimeoutError)
    expect(new WaDisconnectedError('x', false)).not.toBeInstanceOf(WhatsAppError)
  })
})
