import { exit } from 'node:process'

import { readMigrationFiles } from './lib/migration-files.js'
import { findTransactionProblems } from './lib/migration-transactions.js'

const DIRECTORY = 'prisma/migrations'

try {
  const files = readMigrationFiles(DIRECTORY)
  const problems = findTransactionProblems(files)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    exit(1)
  }
  console.log(`${files.length} migrations, each atomic`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  exit(1)
}
