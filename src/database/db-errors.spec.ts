import { Prisma } from '../generated/prisma/client.js'

import {
  isRecordNotFound,
  isSerializationFailure,
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
    expect(isSerializationFailure(knownError('P2034'))).toBe(true)
    expect(isSerializationFailure(knownError('P2002'))).toBe(false)
  })

  it('does not take any other error for them', () => {
    expect(isRecordNotFound(new Error('P2025'))).toBe(false)
    expect(isUniqueViolation('P2002')).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
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
