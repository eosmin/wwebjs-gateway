import { Prisma } from '../generated/prisma/client.js'

import {
  isForeignKeyViolation,
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

    it.each(['P2002', 'P2003', 'P2025'])('does not take %s, which would fail again', code => {
      expect(isTransientDbError(knownError(code))).toBe(false)
    })

    it('does not take any other error for transient', () => {
      expect(isTransientDbError(new Error('P1001'))).toBe(false)
      expect(isTransientDbError(undefined)).toBe(false)
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
