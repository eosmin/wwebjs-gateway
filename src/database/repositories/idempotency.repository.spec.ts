import type { PrismaService } from '../prisma.service.js'

import { IdempotencyRepository } from './idempotency.repository.js'

// The claim loop depends on a purge landing between two statements, which a real database cannot
// be made to do on demand, so the two statements are scripted here
function repositoryWith(counts: number[], found: Array<{ requestHash: string } | null>) {
  const createMany = jest.fn()
  for (const count of counts) createMany.mockResolvedValueOnce({ count })
  const findUnique = jest.fn()
  for (const row of found) findUnique.mockResolvedValueOnce(row)
  const prisma = { idempotencyKey: { createMany, findUnique } } as unknown as PrismaService
  return { repository: new IdempotencyRepository(prisma), createMany, findUnique }
}

describe('IdempotencyRepository.claim', () => {
  it('inserts with skipDuplicates and reads the winner when the insert is a duplicate', async () => {
    const existing = { requestHash: 'h0' }
    const { repository, createMany, findUnique } = repositoryWith([0], [existing])

    await expect(repository.claim('s', 'k', 'h')).resolves.toEqual({ claimed: false, existing })
    expect(createMany).toHaveBeenCalledWith({
      data: [{ sessionId: 's', key: 'k', requestHash: 'h' }],
      skipDuplicates: true
    })
    expect(findUnique).toHaveBeenCalledWith({
      where: { sessionId_key: { sessionId: 's', key: 'k' } }
    })
  })

  it('claims again when the row that blocked the insert is purged before it is read', async () => {
    const { repository, createMany } = repositoryWith([0, 1], [null])

    await expect(repository.claim('s', 'k', 'h')).resolves.toEqual({ claimed: true })
    expect(createMany).toHaveBeenCalledTimes(2)
  })

  it('gives up when the row vanishes twice in a row', async () => {
    const { repository } = repositoryWith([0, 0], [null, null])

    await expect(repository.claim('s', 'k', 'h')).rejects.toThrow(/purge/)
  })
})

describe('IdempotencyRepository.release', () => {
  it('deletes only a key that is still pending', async () => {
    const deleteMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    const prisma = { idempotencyKey: { deleteMany } } as unknown as PrismaService
    const repository = new IdempotencyRepository(prisma)

    await expect(repository.release('s', 'k')).resolves.toBe(true)
    await expect(repository.release('s', 'done-key')).resolves.toBe(false)
    expect(deleteMany).toHaveBeenCalledWith({
      where: { sessionId: 's', key: 'k', status: 'pending' }
    })
  })
})
