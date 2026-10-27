import { readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { envSchema } from '../src/config/env.schema.js'

import { findEnvExampleProblems } from './lib/env-example.js'

const problems = findEnvExampleProblems(envSchema, readFileSync('.env.example', 'utf8'))

if (problems.length > 0) {
  console.error('.env.example and src/config/env.schema.ts disagree:')
  for (const problem of problems) console.error(`  ${problem}`)
  exit(1)
}
console.log('env examples match their schemas')
