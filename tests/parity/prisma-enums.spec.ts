import { SessionStatus as PrismaSessionStatus } from '../../src/generated/prisma/enums.js'
import { SESSION_STATUSES } from '../../src/types/dto.js'

// The Prisma enum and the Zod enum describe the same state machine; a status added to one and not
// the other would only fail at runtime, on the first write. The client is generated and git-ignored:
// run `pnpm db:generate` first (CI does) or this file fails with "Cannot find module".
describe('Prisma enums', () => {
  it('SessionStatus has the same values as SESSION_STATUSES', () => {
    expect(Object.values(PrismaSessionStatus).sort()).toEqual([...SESSION_STATUSES].sort())
  })
})
