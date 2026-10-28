import { Prisma } from '../generated/prisma/client.js'

const RECORD_NOT_FOUND = 'P2025'
const UNIQUE_VIOLATION = 'P2002'
const FOREIGN_KEY_VIOLATION = 'P2003'
const WRITE_CONFLICT = 'P2034'

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

// Runs a write that targets one row; a row that does not exist gives null instead of an error
export async function nullIfMissing<T>(write: Promise<T>): Promise<T | null> {
  try {
    return await write
  } catch (error) {
    if (isRecordNotFound(error)) return null
    throw error
  }
}
