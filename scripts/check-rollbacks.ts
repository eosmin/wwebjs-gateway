import { readdirSync } from 'node:fs'
import { exit } from 'node:process'

import { findRollbackProblems } from './lib/rollbacks.js'

// A directory that does not exist yet is an empty one: the first migration comes with the schema.
// Any other failure (a permission error, a file where the directory should be) is not "empty".
function list(directory: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory()
    }))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

const migrations = list('prisma/migrations')
  .filter(entry => entry.isDirectory)
  .map(entry => entry.name)
const rollbacks = list('prisma/rollbacks')
  .filter(entry => !entry.isDirectory)
  .map(entry => entry.name)
const problems = findRollbackProblems(migrations, rollbacks)

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  exit(1)
}
console.log(`${migrations.length} migrations, each with a rollback`)
