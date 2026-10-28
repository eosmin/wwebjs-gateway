export interface RetryOptions {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
  // Receives the failure and the attempt that just failed (1-based); false stops retrying
  shouldRetry?: (error: unknown, attempt: number) => boolean
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// The longest wait of an attempt (1-based): baseDelayMs doubled per attempt, up to maxDelayMs
export function backoffCeilingMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
}

// Exponential backoff with full jitter: a random delay in [0, backoffCeilingMs]
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random
): number {
  return Math.floor(random() * (backoffCeilingMs(attempt, baseDelayMs, maxDelayMs) + 1))
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs, shouldRetry, sleep = defaultSleep, random } = options
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt >= attempts || shouldRetry?.(error, attempt) === false) throw error
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random))
    }
  }
}
