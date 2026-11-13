// What WhatsApp Web leaves behind when it logs a session out on its own, read without storing the
// address or any user data: the short reason token of the logout address, and the few fixed lines
// the page writes to its console about a reload or a logout (H-LIVE-05, F25).

// Starts with a letter and holds no run of six digits: a token cannot be an account id
const REASON_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/
const MAX_LINE_LENGTH = 160
// eslint-disable-next-line no-control-regex -- control characters are exactly what is dropped
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
// Digits of any script, with the separators a phone number is written with, spanning six characters
const NUMBER = /\+?\p{Nd}[\p{Nd}\s().-]{4,}\p{Nd}/gu
const WEB_ADDRESS = /https?:\/\/\S+/gi
const ACCOUNT_ID = /\S*@\S*/g
// The most of a console line that is looked at: a huge line costs nothing
const MAX_RAW_LENGTH = 1000

// The value of `logout_reason` of the address, only when it is a short token of letters, digits and
// underscores: anything else (an account id, a message, markup) is left out, never logged.
export function logoutReasonOf(address: string): string | undefined {
  try {
    const value = new URL(address).searchParams.get('logout_reason')
    return value !== null && REASON_PATTERN.test(value) && !/\d{6,}/.test(value) ? value : undefined
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

// A line of the page console as it may be logged: no control characters, web addresses, account ids
// (anything with an @) and phone-number-like digit runs of any script masked, at most 160 characters.
export function cleanConsoleLine(line: string): string {
  return line
    .slice(0, MAX_RAW_LENGTH)
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(WEB_ADDRESS, '<url>')
    .replace(ACCOUNT_ID, '<id>')
    .replace(NUMBER, '#')
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
