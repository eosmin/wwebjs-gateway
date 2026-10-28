import type { ExecutionContext } from '@nestjs/common'
import { NEVER, firstValueFrom, of, throwError } from 'rxjs'

import type { AppConfig } from '../../config/env.schema.js'

import { TimeoutInterceptor } from './timeout.interceptor.js'

const CONFIG = { WA_CALL_TIMEOUT_MS: 20, SEND_SYNC_TIMEOUT_MS: 50 } satisfies Partial<AppConfig>

describe('TimeoutInterceptor', () => {
  const interceptor = new TimeoutInterceptor(CONFIG as AppConfig)
  const context = {} as ExecutionContext

  afterEach(() => {
    jest.useRealTimers()
  })

  it('lets a handler that answers in time through', async () => {
    await expect(
      firstValueFrom(interceptor.intercept(context, { handle: () => of('done') }))
    ).resolves.toBe('done')
  })

  it('fails with WHATSAPP_TIMEOUT once the longest configured limit plus the grace has passed', async () => {
    jest.useFakeTimers()
    const outcome = firstValueFrom(interceptor.intercept(context, { handle: () => NEVER }))
    const assertion = expect(outcome).rejects.toMatchObject({
      code: 'WHATSAPP_TIMEOUT',
      status: 504,
      details: { timeoutMs: 5050 }
    })

    let settled = false
    void outcome.catch(() => (settled = true))
    await jest.advanceTimersByTimeAsync(5049)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)

    await assertion
  })

  it('passes any other failure on untouched', async () => {
    const failure = new Error('boom')

    await expect(
      firstValueFrom(interceptor.intercept(context, { handle: () => throwError(() => failure) }))
    ).rejects.toBe(failure)
  })
})
