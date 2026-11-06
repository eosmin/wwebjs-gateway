import { Prisma } from '../generated/prisma/client.js'

const RECORD_NOT_FOUND = 'P2025'
const UNIQUE_VIOLATION = 'P2002'
const FOREIGN_KEY_VIOLATION = 'P2003'
const WRITE_CONFLICT = 'P2034'
// The database cannot be reached, closed the connection, or the pool or the operation timed out:
// the same write can work a moment later
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  WRITE_CONFLICT
])

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
}

// An update or delete that matched no row
export const isRecordNotFound = (error: unknown): boolean => hasCode(error, RECORD_NOT_FOUND)

export const isUniqueViolation = (error: unknown): boolean => hasCode(error, UNIQUE_VIOLATION)

// A write that points at a row that does not exist (or no longer does)
export const isForeignKeyViolation = (error: unknown): boolean =>
  hasCode(error, FOREIGN_KEY_VIOLATION)

// A transaction that lost to a concurrent one (serializable isolation); running it again is safe
export const isSerializationFailure = (error: unknown): boolean => hasCode(error, WRITE_CONFLICT)

// A failure that waiting can cure (the connection dropped, the pool was exhausted), as opposed to
// one that would fail again (a constraint, a bad value)
export const isTransientDbError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientInitializationError ||
  (error instanceof Prisma.PrismaClientKnownRequestError && TRANSIENT_CODES.has(error.code))

// Runs a write that targets one row; a row that does not exist gives null instead of an error
export async function nullIfMissing<T>(write: Promise<T>): Promise<T | null> {
  try {
    return await write
  } catch (error) {
    if (isRecordNotFound(error)) return null
    throw error
  }
}
