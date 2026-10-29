import type { QuietHours } from '../types/send-policy.dto.js'

const MS_PER_DAY = 86_400_000
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/g

// The text two messages are compared by: case, spacing, digits and links are what a template
// changes from one recipient to the next, so they do not make two messages different
export function normalizeContent(body: string): string {
  return body
    .toLowerCase()
    .replace(URL_PATTERN, '<url>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

// Whole-message comparison for opt-out keywords: case and spacing only, so "STOP " matches "stop"
export function normalizeKeyword(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

// 1 for an account linked `warmupDays` ago or earlier, ramping linearly from `startFraction`. A
// session that never linked has no age yet, so it gets the start.
export function warmupFactor(
  linkedAt: Date | null,
  now: number,
  warmupDays: number,
  startFraction: number
): number {
  if (warmupDays === 0) return 1
  if (!linkedAt) return startFraction
  const ageDays = Math.max(0, now - linkedAt.getTime()) / MS_PER_DAY
  return startFraction + (1 - startFraction) * Math.min(1, ageDays / warmupDays)
}

// A budget scaled by the ramp and the health throttle. A budget of 0 stays 0 (it means "none");
// any other never drops below 1, or the session could not send at all.
export function scaleBudget(max: number, factor: number): number {
  // The epsilon keeps 0.55 * 20 from landing on 10.999999999999998
  return max === 0 ? 0 : Math.max(1, Math.floor(max * factor + 1e-9))
}

function minuteOfDay(clockText: string): number {
  const [hours = '0', minutes = '0'] = clockText.split(':')
  return Number(hours) * 60 + Number(minutes)
}

interface LocalTime {
  year: number
  month: number
  day: number
  msOfDay: number
}

// The wall clock of a zone at an instant, read without a date library
function localTime(timezone: string, at: number): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(at)
  const part = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0)
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    msOfDay:
      part('hour') * MS_PER_HOUR +
      part('minute') * MS_PER_MINUTE +
      part('second') * 1000 +
      (((at % 1000) + 1000) % 1000)
  }
}

// Milliseconds the zone is ahead of UTC at an instant (negative for the Americas)
function offsetMs(timezone: string, at: number): number {
  const local = localTime(timezone, at)
  const asUtc = Date.UTC(local.year, local.month - 1, local.day) + local.msOfDay
  return asUtc - at
}

// The instant at which the wall clock of the zone reads the given day and time. A time that a
// clock change repeats has two instants and one that it skips has none; the later one is taken
// (for a skipped time, the instant it would have had with the offset before the change), so a
// quiet window never ends earlier than its wall-clock end.
function instantOf(timezone: string, day: Date, msOfDay: number): number {
  const wall = day.getTime() + msOfDay
  const offsets = [offsetMs(timezone, wall - MS_PER_DAY), offsetMs(timezone, wall + MS_PER_DAY)]
  const candidates = offsets.map(offset => wall - offset)
  const exact = candidates.filter(at => offsetMs(timezone, at) === wall - at)
  return Math.max(...(exact.length > 0 ? exact : candidates))
}

// How long until the quiet window ends: 0 when `at` is outside it. A window that ends before it
// starts runs past midnight; one that starts and ends together is empty. The end is the next time
// the wall clock of the zone reads `to`, so a daylight-saving change inside the window moves the
// wait by the hour it adds or removes.
export function msUntilQuietEnds(quiet: QuietHours | undefined, at: number): number {
  if (!quiet) return 0
  const from = minuteOfDay(quiet.from) * MS_PER_MINUTE
  const to = minuteOfDay(quiet.to) * MS_PER_MINUTE
  if (from === to) return 0
  const now = localTime(quiet.timezone, at)
  const crossesMidnight = to < from
  const inside = crossesMidnight
    ? now.msOfDay >= from || now.msOfDay < to
    : now.msOfDay >= from && now.msOfDay < to
  if (!inside) return 0
  // Only the evening part of a window that crosses midnight ends on the next day
  const endsTomorrow = crossesMidnight && now.msOfDay >= from
  const endDay = new Date(Date.UTC(now.year, now.month - 1, now.day + (endsTomorrow ? 1 : 0)))
  return instantOf(quiet.timezone, endDay, to) - at
}
