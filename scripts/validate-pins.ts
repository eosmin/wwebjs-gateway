import { readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { findUnpinnedDependencies } from './lib/pins.js'

// JSON.parse yields `any`; the shape is the one findUnpinnedDependencies reads, and what it reads is
// checked there
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Parameters<
  typeof findUnpinnedDependencies
>[0]
const problems = findUnpinnedDependencies(manifest)

if (problems.length > 0) {
  console.error('package.json has dependencies that are not pinned to an exact version:')
  for (const problem of problems) console.error(`  ${problem}`)
  exit(1)
}
console.log('every dependency is pinned to an exact version')
