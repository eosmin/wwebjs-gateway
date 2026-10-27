const MS_PER_CHARACTER = 35
const MIN_TYPING_MS = 600
const MAX_TYPING_MS = 8000
const JITTER_FRACTION = 0.2
// WhatsApp drops a typing state after a while, so long waits renew it at this cadence
export const TYPING_RENEW_MS = 20_000

// `auto` typing time: 35 ms per character, ±20 %, kept between 600 ms and 8 s
export function autoTypingMs(bodyLength: number, random: () => number = Math.random): number {
  const jitter = 1 + (random() * 2 - 1) * JITTER_FRACTION
  const ms = Math.round(bodyLength * MS_PER_CHARACTER * jitter)
  return Math.min(MAX_TYPING_MS, Math.max(MIN_TYPING_MS, ms))
}

export function resolveTypingMs(
  typing: 'auto' | number,
  bodyLength: number,
  random?: () => number
): number {
  return typing === 'auto' ? autoTypingMs(bodyLength, random) : Math.max(0, Math.round(typing))
}

// Splits a wait into the stretches between two renewals of the typing state
export function typingSegments(totalMs: number): number[] {
  const segments: number[] = []
  for (let left = totalMs; left > 0; left -= TYPING_RENEW_MS) {
    segments.push(Math.min(left, TYPING_RENEW_MS))
  }
  return segments
}
