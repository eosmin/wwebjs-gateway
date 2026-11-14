// Usage: pnpm docs:gen | pnpm validate:docs (they compile with tsconfig.docs.json first, then run this)
//   no flag: writes every generated file of docs/
//   --check: writes nothing, and exits 1 when a generated file differs from a fresh generation
import { readFileSync, writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

import { GENERATED_DOCS } from './lib/generated-docs.js'

const check = argv.includes('--check')
const stale: string[] = []

for (const { path, render } of GENERATED_DOCS) {
  const expected = await render()
  if (!check) {
    writeFileSync(path, expected)
    continue
  }
  let actual: string | undefined
  try {
    actual = readFileSync(path, 'utf8')
  } catch {
    actual = undefined // a generated file that does not exist yet is as stale as one that differs
  }
  if (actual !== expected) stale.push(path)
}

if (stale.length > 0) {
  console.error('Generated docs are out of date, run `pnpm docs:gen`:')
  for (const path of stale) console.error(`  ${path}`)
  exit(1)
}
console.log(
  check ? `${GENERATED_DOCS.length} generated docs are up to date` : 'generated docs written'
)
