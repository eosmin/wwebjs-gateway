// Waits `ms`; resolves true when the time passed and false as soon as `signal` aborts (also when it
// was already aborted), so a long wait never holds a shutdown back
// setTimeout fires after 1 ms when the delay does not fit in 32 bits, so longer waits are cut to the maximum
const MAX_TIMER_MS = 2_147_483_647

export function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      },
      Math.min(ms, MAX_TIMER_MS)
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
