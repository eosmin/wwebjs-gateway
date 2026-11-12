import { readdirSync, readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { findTransactionProblems, type MigrationFile } from './lib/migration-transactions.js'

const DIRECTORY = 'prisma/migrations'

// A directory that does not exist yet is an empty one; any other failure is not "empty"
function migrationFiles(): MigrationFile[] {
  try {
    return readdirSync(DIRECTORY, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        sql: readFileSync(`${DIRECTORY}/${entry.name}/migration.sql`, 'utf8')
      }))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

const files = migrationFiles()
const problems = findTransactionProblems(files)
if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  exit(1)
}
console.log(`${files.length} migrations, each atomic`)
