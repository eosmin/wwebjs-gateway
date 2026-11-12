import { findTransactionProblems, type MigrationFile } from './migration-transactions.js'

const NONE: ReadonlySet<string> = new Set()
const check = (sql: string, legacy: ReadonlySet<string> = NONE): string[] =>
  findTransactionProblems([{ name: '20270101_new', sql }], legacy)

describe('findTransactionProblems', () => {
  it('accepts a migration wrapped in BEGIN and COMMIT', () => {
    expect(check('-- AlterTable\nBEGIN;\nALTER TABLE "a" ADD COLUMN "b" INT;\nCOMMIT;\n')).toEqual(
      []
    )
  })

  it('accepts lower case and BEGIN TRANSACTION', () => {
    expect(check('begin transaction;\nCREATE TABLE a(b int);\ncommit transaction;')).toEqual([])
  })

  it('ignores BEGIN and COMMIT written inside comments', () => {
    expect(check('-- COMMIT;\nBEGIN;\n/* COMMIT; */ SELECT 1;\nCOMMIT;')).toEqual([])
  })

  it('reports a migration without a transaction', () => {
    expect(check('ALTER TABLE "a" ADD COLUMN "b" INT;')).toEqual([
      expect.stringContaining('20270101_new must start with BEGIN')
    ])
  })

  it('reports a transaction that is never closed', () => {
    expect(check('BEGIN;\nSELECT 1;')).toHaveLength(1)
  })

  it('reports an empty migration', () => {
    expect(check('-- nothing\n')).toHaveLength(1)
  })

  it('reports a COMMIT in the middle, which would leave the rest outside', () => {
    expect(check('BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\nCOMMIT;')).toEqual([
      expect.stringContaining('in the middle')
    ])
  })

  it.each(['CREATE INDEX CONCURRENTLY "i" ON "a"("b")', 'VACUUM "a"'])(
    'reports %s inside a transaction',
    statement => {
      expect(check(`BEGIN;\n${statement};\nCOMMIT;`)).toEqual([
        expect.stringContaining('cannot run in a transaction')
      ])
    }
  )

  it('accepts a statement that cannot run in a transaction when the opt-out says why', () => {
    expect(
      check(
        '-- no-transaction: an index built without locking the table\nCREATE INDEX CONCURRENTLY "i" ON "a"("b");'
      )
    ).toEqual([])
  })

  it('does not accept an opt-out without a reason', () => {
    expect(check('-- no-transaction:\nCREATE INDEX CONCURRENTLY "i" ON "a"("b");')).toHaveLength(1)
  })

  it('does not accept an opt-out that also opens a transaction', () => {
    expect(check('-- no-transaction: because\nBEGIN;\nSELECT 1;\nCOMMIT;')).toEqual([
      expect.stringContaining('opts out of the transaction but still has')
    ])
  })

  it('skips the migrations that were applied before the rule', () => {
    const legacy: ReadonlySet<string> = new Set(['20270101_new'])

    expect(check('ALTER TABLE "a" ADD COLUMN "b" INT;', legacy)).toEqual([])
  })

  it('judges each migration on its own', () => {
    const files: MigrationFile[] = [
      { name: 'a', sql: 'BEGIN;\nSELECT 1;\nCOMMIT;' },
      { name: 'b', sql: 'SELECT 2;' }
    ]

    expect(findTransactionProblems(files, NONE)).toEqual([expect.stringContaining('migration b')])
  })
})
