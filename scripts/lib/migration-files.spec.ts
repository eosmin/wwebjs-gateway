import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readMigrationFiles } from './migration-files.js'
import { findTransactionProblems } from './migration-transactions.js'

describe('readMigrationFiles', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'migrations-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const migration = (name: string, sql?: string): void => {
    mkdirSync(join(root, name))
    if (sql !== undefined) writeFileSync(join(root, name, 'migration.sql'), sql)
  }

  it('reads the sql of every migration folder and skips the lock file', () => {
    migration('20270101000000_a', 'BEGIN; SELECT 1; COMMIT;')
    writeFileSync(join(root, 'migration_lock.toml'), 'provider = "postgresql"')

    expect(readMigrationFiles(root)).toEqual([
      { name: '20270101000000_a', sql: 'BEGIN; SELECT 1; COMMIT;' }
    ])
  })

  it('treats a directory that does not exist yet as no migrations', () => {
    expect(readMigrationFiles(join(root, 'nope'))).toEqual([])
  })

  it('fails, naming the folder, for a migration folder without migration.sql', () => {
    migration('20270101000000_stray')

    expect(() => readMigrationFiles(root)).toThrow(/20270101000000_stray.*migration\.sql/)
  })

  it('does not let an empty folder switch off the check of the others', () => {
    migration('20270101000000_stray')
    migration('20270102000000_bad', 'CREATE TABLE x(id int);')

    // The empty folder is an error, so the run cannot end as "0 migrations, each atomic"
    expect(() => readMigrationFiles(root)).toThrow(/migration\.sql/)
  })

  it('hands a CREATE TABLE without BEGIN and COMMIT to the transaction check as a problem', () => {
    migration('20270102000000_bad', 'CREATE TABLE x(id int);')

    expect(findTransactionProblems(readMigrationFiles(root), new Set())).toEqual([
      expect.stringContaining('20270102000000_bad must start with BEGIN')
    ])
  })

  it('does not hide a failure other than a missing directory', () => {
    writeFileSync(join(root, 'afile'), '')

    // A file where the directory should be: not "empty"
    expect(() => readMigrationFiles(join(root, 'afile'))).toThrow()
  })
})
