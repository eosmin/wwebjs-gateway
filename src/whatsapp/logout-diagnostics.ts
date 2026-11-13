// What WhatsApp Web leaves behind when it logs a session out on its own, read without storing the
// address or any user data: the short reason token of the logout address, and the few fixed lines
// the page writes to its console about a reload or a logout (H-LIVE-05, F25).

const REASON_PATTERN = /^[A-Za-z0-9_]{1,48}$/
const MAX_LINE_LENGTH = 160
// eslint-disable-next-line no-control-regex -- control characters are exactly what is dropped
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
const LONG_NUMBER = /\d{6,}/g

// The value of `logout_reason` of the address, only when it is a short token of letters, digits and
// underscores: anything else (an account id, a message, markup) is left out, never logged.
export function logoutReasonOf(address: string): string | undefined {
  try {
    const value = new URL(address).searchParams.get('logout_reason')
    return value !== null && REASON_PATTERN.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function isLogoutRelevant(line: string): boolean {
  return (
    line.startsWith('[reload]') ||
    line.includes('storage initialization error') ||
    line.includes('logging out')
  )
}

// A line of the page console as it may be logged: no control characters, runs of six or more digits
// (a phone number, an id) masked, at most 160 characters.
export function cleanConsoleLine(line: string): string {
  return line
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(LONG_NUMBER, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LINE_LENGTH)
}

// The most recent relevant lines of a session that is running well, kept only to be given back when
// a logout follows: what happened in the seconds before it.
export class ConsoleTail {
  private lines: { at: number; text: string }[] = []

  constructor(
    private readonly windowMs: number,
    private readonly size: number,
    private readonly clock: () => number = Date.now
  ) {}

  add(text: string): void {
    this.lines.push({ at: this.clock(), text })
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size)
  }

  // The lines of the last window, oldest first. Reading empties the tail.
  recent(): string[] {
    const from = this.clock() - this.windowMs
    const result = this.lines.filter(line => line.at >= from).map(line => line.text)
    this.lines = []
    return result
  }
}
