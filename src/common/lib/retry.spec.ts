import { backoffCeilingMs, backoffDelayMs, retry } from './retry.js'

const base = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }

describe('backoffCeilingMs', () => {
  it('doubles per attempt and stops at the maximum', () => {
    expect([1, 2, 3, 4, 5].map(attempt => backoffCeilingMs(attempt, 100, 1000))).toEqual([
      100, 200, 400, 800, 1000
    ])
  })
})

describe('backoffDelayMs', () => {
  it('doubles the ceiling per attempt up to the maximum', () => {
    const top = (attempt: number): number => backoffDelayMs(attempt, 100, 1000, () => 0.999999)
    expect([top(1), top(2), top(3), top(4), top(5)]).toEqual([100, 200, 400, 800, 1000])
  })

  it('draws the delay between zero and the ceiling', () => {
    expect(backoffDelayMs(2, 100, 1000, () => 0)).toBe(0)
  })
})

describe('retry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = jest.fn(() => Promise.resolve())
    await expect(retry(() => Promise.resolve('ok'), { ...base, sleep })).resolves.toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries until the operation succeeds, passing the attempt number', async () => {
    const sleep = jest.fn(() => Promise.resolve())
    const operation = jest
      .fn<Promise<string>, [number]>()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockResolvedValueOnce('done')
    await expect(retry(operation, { ...base, sleep, random: () => 0.5 })).resolves.toBe('done')
    expect(operation.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3])
    expect(sleep.mock.calls).toEqual([[50], [100]])
  })

  it('throws the last failure once the attempts are used up', async () => {
    const operation = jest.fn<Promise<never>, [number]>().mockRejectedValue(new Error('nope'))
    await expect(retry(operation, { ...base, sleep: () => Promise.resolve() })).rejects.toThrow(
      'nope'
    )
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('stops at once when shouldRetry refuses the failure', async () => {
    const operation = jest.fn<Promise<never>, [number]>().mockRejectedValue(new Error('fatal'))
    const shouldRetry = jest.fn(() => false)
    await expect(
      retry(operation, { ...base, shouldRetry, sleep: () => Promise.resolve() })
    ).rejects.toThrow('fatal')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 1)
  })
})
