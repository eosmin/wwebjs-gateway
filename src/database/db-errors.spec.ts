import { Prisma } from '../generated/prisma/client.js'

import {
  isForeignKeyViolation,
  isRetrySafeDbError,
  isRecordNotFound,
  isSerializationFailure,
  isTransientDbError,
  isUniqueViolation,
  nullIfMissing
} from './db-errors.js'

const knownError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' })

describe('db-errors', () => {
  it('recognises the codes of a missing row and of a unique violation', () => {
    expect(isRecordNotFound(knownError('P2025'))).toBe(true)
    expect(isRecordNotFound(knownError('P2002'))).toBe(false)
    expect(isUniqueViolation(knownError('P2002'))).toBe(true)
    expect(isUniqueViolation(knownError('P2025'))).toBe(false)
    expect(isForeignKeyViolation(knownError('P2003'))).toBe(true)
    expect(isForeignKeyViolation(knownError('P2002'))).toBe(false)
    expect(isSerializationFailure(knownError('P2034'))).toBe(true)
    expect(isSerializationFailure(knownError('P2002'))).toBe(false)
  })

  it('does not take any other error for them', () => {
    expect(isRecordNotFound(new Error('P2025'))).toBe(false)
    expect(isUniqueViolation('P2002')).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })

  describe('isTransientDbError', () => {
    it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'])(
      'takes %s for transient',
      code => {
        expect(isTransientDbError(knownError(code))).toBe(true)
      }
    )

    it('takes a connection that cannot be opened for transient', () => {
      expect(
        isTransientDbError(new Prisma.PrismaClientInitializationError('down', 'test', 'P1001'))
      ).toBe(true)
    })

    it.each(['P2002', 'P2003', 'P2025', 'P2000', 'P2010', 'P2011', 'P2014'])(
      'does not take %s, which would fail again',
      code => {
        expect(isTransientDbError(knownError(code))).toBe(false)
      }
    )

    it.each(['P2028', 'P2037'])('takes %s (transaction expired, too many connections)', code => {
      expect(isTransientDbError(knownError(code))).toBe(true)
    })

    // Raw SQL and the driver adapter report the Postgres code (SQLSTATE) in other places
    const rawError = (meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError =>
      new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2010',
        clientVersion: 'test',
        meta
      })

    it.each(['40001', '40P01', '53300', '55P03', '57P01', '57P02', '57P03', '08000', '08006'])(
      'takes the Postgres code %s in meta.code for transient',
      code => {
        expect(isTransientDbError(rawError({ code }))).toBe(true)
      }
    )

    it.each(['40001', '57P01', '08006'])(
      'takes the Postgres code %s of the driver adapter for transient',
      originalCode => {
        expect(
          isTransientDbError(rawError({ driverAdapterError: { cause: { originalCode } } }))
        ).toBe(true)
      }
    )

    it.each(['23505', '23503', '42P01', '22001', '42601', '08P01', '08004'])(
      'does not take the Postgres code %s, which would fail again',
      code => {
        expect(isTransientDbError(rawError({ code }))).toBe(false)
      }
    )

    it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', '57P01', '40001'])(
      'takes a plain error with code %s for transient',
      code => {
        expect(isTransientDbError(Object.assign(new Error('boom'), { code }))).toBe(true)
      }
    )

    it('looks through the cause of a wrapped error', () => {
      const wrapped = new Error('wrapper', {
        cause: Object.assign(new Error('x'), { code: '57P01' })
      })
      expect(isTransientDbError(wrapped)).toBe(true)
    })

    it('stops following a cause that points back to itself', () => {
      const loop: Error & { cause?: unknown } = new Error('loop')
      loop.cause = loop
      expect(isTransientDbError(loop)).toBe(false)
    })

    it('does not take a plain error with an unrelated code for transient', () => {
      expect(isTransientDbError(Object.assign(new Error('boom'), { code: 'ENOENT' }))).toBe(false)
      expect(isTransientDbError(Object.assign(new Error('boom'), { code: 42 }))).toBe(false)
    })

    it('does not take any other error for transient', () => {
      expect(isTransientDbError(new Error('P1001'))).toBe(false)
      expect(isTransientDbError(undefined)).toBe(false)
    })
  })

  // A write that is not idempotent (a counter) may be run again only when the first run certainly did
  // not take effect: a connection that dropped while the statement or its COMMIT was in flight is an
  // unknown outcome and is not on this list
  describe('isRetrySafeDbError', () => {
    const rawError = (meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError =>
      new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2010',
        clientVersion: 'test',
        meta
      })

    it.each(['P2024', 'P2034', 'P2037'])(
      'takes %s, where the statement did not run or was rolled back',
      code => {
        expect(isRetrySafeDbError(knownError(code))).toBe(true)
      }
    )

    it('takes a connection that could not be opened', () => {
      expect(
        isRetrySafeDbError(new Prisma.PrismaClientInitializationError('down', 'test', 'P1001'))
      ).toBe(true)
    })

    it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2028'])(
      'does not take %s: the statement may have been committed',
      code => {
        expect(isRetrySafeDbError(knownError(code))).toBe(false)
      }
    )

    it.each(['08001', '40001', '40P01', '53300', '55P03', '57P03'])(
      'takes the Postgres code %s',
      code => {
        expect(isRetrySafeDbError(rawError({ code }))).toBe(true)
        expect(
          isRetrySafeDbError(rawError({ driverAdapterError: { cause: { originalCode: code } } }))
        ).toBe(true)
      }
    )

    it.each(['08000', '08003', '08006', '08007', '57P01', '57P02'])(
      'does not take the Postgres code %s: the connection was lost and the outcome is unknown',
      code => {
        expect(isRetrySafeDbError(rawError({ code }))).toBe(false)
        expect(
          isRetrySafeDbError(rawError({ driverAdapterError: { cause: { originalCode: code } } }))
        ).toBe(false)
      }
    )

    it.each(['ECONNREFUSED', 'EAI_AGAIN'])('takes the socket error %s (never connected)', code => {
      expect(isRetrySafeDbError(Object.assign(new Error('boom'), { code }))).toBe(true)
    })

    it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE'])(
      'does not take the socket error %s (it can drop after the COMMIT)',
      code => {
        expect(isRetrySafeDbError(Object.assign(new Error('boom'), { code }))).toBe(false)
      }
    )

    it('does not take what would fail again, or anything that is not an error of the database', () => {
      expect(isRetrySafeDbError(knownError('P2002'))).toBe(false)
      expect(isRetrySafeDbError(new Error('P1001'))).toBe(false)
      expect(isRetrySafeDbError(undefined)).toBe(false)
    })

    it('looks through the cause of a wrapped error', () => {
      const wrapped = new Error('wrapper', {
        cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
      })
      expect(isRetrySafeDbError(wrapped)).toBe(true)
    })

    it('is never wider than isTransientDbError', () => {
      const errors = [
        ...['P1001', 'P1002', 'P2024', 'P2034', 'P2037', 'P2002', 'P1008'].map(knownError),
        ...['08001', '08006', '40001', '57P01'].map(code => rawError({ code })),
        ...['ECONNREFUSED', 'ECONNRESET', 'ENOENT'].map(code =>
          Object.assign(new Error('boom'), { code })
        )
      ]
      for (const error of errors) {
        expect(!isRetrySafeDbError(error) || isTransientDbError(error)).toBe(true)
      }
    })

    it('is unsafe when any code of the chain leaves the outcome open, whatever the order', () => {
      const refusedOverReset = Object.assign(new Error('outer'), {
        code: 'ECONNREFUSED',
        cause: Object.assign(new Error('inner'), { code: '08006' })
      })
      const resetOverRefused = Object.assign(new Error('outer'), {
        code: '08006',
        cause: Object.assign(new Error('inner'), { code: 'ECONNREFUSED' })
      })

      expect(isRetrySafeDbError(refusedOverReset)).toBe(false)
      expect(isRetrySafeDbError(resetOverRefused)).toBe(false)
    })
  })

  describe('nullIfMissing', () => {
    it('gives the value of a write that worked', async () => {
      await expect(nullIfMissing(Promise.resolve(7))).resolves.toBe(7)
    })

    it('gives null for a row that does not exist', async () => {
      await expect(nullIfMissing(Promise.reject(knownError('P2025')))).resolves.toBeNull()
    })

    it('lets any other failure through', async () => {
      const failure = knownError('P2003')

      await expect(nullIfMissing(Promise.reject(failure))).rejects.toBe(failure)
    })
  })
})
