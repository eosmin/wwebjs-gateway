import { WhatsAppError } from '../errors.js'

// Rejects with WHATSAPP_TIMEOUT when `operation` has not settled after `timeoutMs`. The operation itself
// cannot be cancelled (Puppeteer offers no abort), so its late result or failure is swallowed here.
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new WhatsAppError('WHATSAPP_TIMEOUT', `${label} timed out after ${timeoutMs} ms`, {
          operation: label,
          timeoutMs
        })
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
    operation.catch(() => undefined)
  }
}
