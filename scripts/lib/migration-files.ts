import { readdirSync, readFileSync } from 'node:fs'

import type { MigrationFile } from './migration-transactions.js'

// Not `instanceof Error`: an error from `node:fs` can come from another realm (Jest's)
const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

// The migration folders with their sql. A directory that does not exist yet is an empty one (the first
// migration comes with the schema), and only that: a folder without `migration.sql` is a failure that
// names it, never "no migrations", or one stray folder would switch the check off for all the others.
export function readMigrationFiles(directory: string): MigrationFile[] {
  let folders: string[]
  try {
    folders = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return folders.map(name => {
    try {
      return { name, sql: readFileSync(`${directory}/${name}/migration.sql`, 'utf8') }
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(`migration folder ${name} has no migration.sql: remove it or finish it`, {
          cause: error
        })
      }
      throw error
    }
  })
}
