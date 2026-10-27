// What CI would fail on (pre-push hook). No Docker, no database.
// Usage: tsx scripts/validate-affected.ts [--since <sha>]
//   --since: the commit the remote branch is at, which the pre-push hook passes. What is pushed is
//   then the commits after it, so a documentation commit on top of code that was already checked
//   is not checked again.
import { execFileSync, spawnSync } from 'node:child_process'
import { argv, exit } from 'node:process'

import { isDocsOnly } from './lib/affected.js'

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const hint =
      args[0] === 'merge-base' ? '\nis this a shallow clone? try `git fetch --unshallow`' : ''
    console.error(`git ${args.join(' ')} failed: ${detail}${hint}`)
    exit(1)
  }
}
function exists(ref: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref]).status === 0
}
function isAncestorOfHead(commit: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0
}
function changedSince(commit: string): string[] {
  return git('diff', '--name-only', '--no-renames', commit, 'HEAD').split('\n').filter(Boolean)
}

const baseRef = ['origin/main', 'main'].find(exists)
if (baseRef === undefined) {
  console.error('neither origin/main nor main exists here: run `git fetch origin main` first')
  exit(1)
}
const base = git('merge-base', baseRef, 'HEAD')
const changed = changedSince(base)
if (changed.length === 0) {
  console.log(`nothing changed since ${baseRef}: nothing to check`)
  exit(0)
}

// A remote commit that this clone does not have, or that is no longer behind HEAD (a rebased
// branch), cannot tell what is pushed: then the whole branch is checked
const sinceIndex = argv.indexOf('--since')
const since = sinceIndex === -1 ? undefined : argv[sinceIndex + 1]
const pushed = since !== undefined && isAncestorOfHead(since) ? changedSince(since) : changed
if (pushed.length === 0) {
  console.log('nothing new is pushed: nothing to check')
  exit(0)
}

const DOCS_STEPS = [{ name: 'validate:docs', command: ['validate:docs'] }]
const CODE_STEPS = [
  { name: 'lint', command: ['lint'] },
  { name: 'type-check', command: ['type-check'] },
  { name: 'test (unit)', command: ['test'] },
  { name: 'format:check', command: ['format:check'] },
  { name: 'validate:env', command: ['validate:env'] },
  { name: 'validate:deprecations', command: ['validate:deprecations'] },
  { name: 'validate:rollbacks', command: ['validate:rollbacks'] },
  ...DOCS_STEPS
]
const steps = isDocsOnly(pushed) ? DOCS_STEPS : CODE_STEPS

for (const { name, command } of steps) {
  console.log(`\n> ${name}`)
  const result = spawnSync('pnpm', command, { stdio: 'inherit' })
  if (result.error !== undefined) console.error(`could not run pnpm: ${result.error.message}`)
  if (result.status !== 0) {
    console.error(`\n${name} failed: fix it before pushing (CI would fail on it too)`)
    exit(result.status ?? 1)
  }
}
console.log('\nall checks passed')
