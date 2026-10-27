import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { exit } from 'node:process'

import { findDeprecations, isScanned } from './lib/deprecations.js'

// What git sees, without what .gitignore hides. NUL-separated so that a name with accents is not quoted.
const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  }
)
const files = [...new Set(listed.split('\0'))].filter(
  file => file !== '' && statSync(file, { throwIfNoEntry: false })?.isFile() === true
)
const findings = files.flatMap(file =>
  isScanned(file) ? findDeprecations(file, readFileSync(file, 'utf8')) : []
)

if (findings.length > 0) {
  console.error('Removed or renamed APIs are back in the code:')
  for (const { file, line, api, replacement } of findings) {
    console.error(`  ${file}:${line}  ${api}  ->  ${replacement}`)
  }
  exit(1)
}
console.log(`no deprecated API in ${files.filter(isScanned).length} files`)
