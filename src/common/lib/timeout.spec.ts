import { WhatsAppError } from '../errors.js'

import { withTimeout } from './timeout.js'

describe('withTimeout', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('returns the value of an operation that settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'op')).resolves.toBe(7)
  })

  it('propagates the failure of an operation that rejects in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'op')).rejects.toThrow('boom')
  })

  it('rejects with WHATSAPP_TIMEOUT naming the operation when it hangs', async () => {
    const hanging = new Promise<never>(() => undefined)
    const result = withTimeout(hanging, 500, 'chat.fetch')
    const assertion = expect(result).rejects.toMatchObject({
      code: 'WHATSAPP_TIMEOUT',
      details: { operation: 'chat.fetch', timeoutMs: 500 }
    })
    await jest.advanceTimersByTimeAsync(500)
    await assertion
    await expect(result).rejects.toBeInstanceOf(WhatsAppError)
  })

  it('swallows the late failure of an operation that already timed out', async () => {
    let fail: (error: Error) => void = () => undefined
    const late = new Promise<never>((_resolve, reject) => {
      fail = reject
    })
    const result = withTimeout(late, 100, 'op')
    const assertion = expect(result).rejects.toMatchObject({ code: 'WHATSAPP_TIMEOUT' })
    await jest.advanceTimersByTimeAsync(100)
    await assertion
    fail(new Error('late'))
    await jest.advanceTimersByTimeAsync(0)
  })

  it('leaves no timer behind once the operation settles', async () => {
    await withTimeout(Promise.resolve(1), 1000, 'op')
    expect(jest.getTimerCount()).toBe(0)
  })
})
