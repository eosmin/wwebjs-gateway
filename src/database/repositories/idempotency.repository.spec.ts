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
  return { repository: new IdempotencyRepository(prisma), createMany }
}

describe('IdempotencyRepository.claim', () => {
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
