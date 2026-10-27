import { findRollbackProblems } from './rollbacks.js'

describe('findRollbackProblems', () => {
  it('accepts no migrations at all', () => {
    expect(findRollbackProblems([], [])).toEqual([])
  })

  it('accepts a migration that has its rollback', () => {
    expect(findRollbackProblems(['20260101_init'], ['20260101_init.rollback.sql'])).toEqual([])
  })

  it('reports a migration without a rollback', () => {
    expect(findRollbackProblems(['20260101_init'], [])).toEqual([
      'migration 20260101_init has no rollbacks/20260101_init.rollback.sql'
    ])
  })

  it('reports a rollback without a migration', () => {
    expect(findRollbackProblems([], ['20260101_init.rollback.sql'])).toEqual([
      'rollbacks/20260101_init.rollback.sql matches no migration'
    ])
  })

  it('ignores files that are not rollback scripts, such as .gitkeep', () => {
    expect(findRollbackProblems([], ['.gitkeep'])).toEqual([])
  })
})
