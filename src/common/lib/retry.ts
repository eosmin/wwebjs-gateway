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

// Exponential backoff with full jitter: a random delay in [0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))]
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.floor(random() * (ceiling + 1))
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
