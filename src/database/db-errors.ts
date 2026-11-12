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
  // A transaction that expired or was closed under load; too many connections open
  'P2028',
  'P2037',
  WRITE_CONFLICT
])
// Postgres error codes (SQLSTATE) that waiting cures: a lost connection (class 08, the codes below), a
// serialization failure or deadlock, no connection slot left, a server that is shutting down or
// starting, a lock that was not available
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  // connection_exception, connection_does_not_exist, connection_failure,
  // sqlclient_unable_to_establish_sqlconnection, transaction_resolution_unknown (a protocol
  // violation, 08P01, or a rejected connection, 08004, would fail again)
  '08000',
  '08001',
  '08003',
  '08006',
  '08007',
  '40001',
  '40P01',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03'
])
// The errors Node gives for a socket that dropped, timed out or could not resolve the host
const TRANSIENT_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN'
])
// How far down a chain of `cause` the code is looked for
const MAX_CAUSE_DEPTH = 5

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
  (error instanceof Prisma.PrismaClientKnownRequestError && TRANSIENT_CODES.has(error.code)) ||
  databaseCodesOf(error).some(isTransientCode)

const isTransientCode = (code: string): boolean =>
  TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SOCKET_CODES.has(code)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

// Every Postgres or socket code an error carries: raw SQL and the driver adapter put the SQLSTATE in
// `meta.code` or `meta.driverAdapterError.cause.originalCode`, a driver error in `code`, and a
// wrapper in `cause`
function databaseCodesOf(error: unknown): string[] {
  const codes: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
    const record = asRecord(current)
    if (!record || seen.has(record)) break
    seen.add(record)
    const meta = asRecord(record.meta)
    const adapterCause = asRecord(asRecord(meta?.driverAdapterError)?.cause)
    for (const candidate of [record.code, meta?.code, adapterCause?.originalCode]) {
      if (typeof candidate === 'string') codes.push(candidate)
    }
    current = record.cause
  }
  return codes
}

// Runs a write that targets one row; a row that does not exist gives null instead of an error
export async function nullIfMissing<T>(write: Promise<T>): Promise<T | null> {
  try {
    return await write
  } catch (error) {
    if (isRecordNotFound(error)) return null
    throw error
  }
}
