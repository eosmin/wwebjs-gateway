import { isCommitSha, isDocsOnly } from './affected.js'

describe('isDocsOnly', () => {
  it('is true when every changed file is under docs/', () => {
    expect(isDocsOnly(['docs/TDD.md', 'docs/adr/0001.md'])).toBe(true)
  })

  it('is false as soon as one file is code', () => {
    expect(isDocsOnly(['docs/TDD.md', 'src/main.ts'])).toBe(false)
  })

  it('is false when nothing changed, so that an empty push is never "docs only"', () => {
    expect(isDocsOnly([])).toBe(false)
  })
})

describe('isCommitSha', () => {
  it.each([
    ['a SHA-1 hash', 'a'.repeat(40)],
    ['a SHA-256 hash', '0123456789abcdef'.repeat(4)]
  ])('accepts %s', (_label, value) => {
    expect(isCommitSha(value)).toBe(true)
  })

  it.each([
    ['nothing at all', undefined],
    ['an empty string', ''],
    ['an abbreviated hash', 'abc1234'],
    ['a branch name', 'origin/main'],
    ['an option that git would read as a flag', '--output=/tmp/x'],
    ['a hash with trailing text', `${'a'.repeat(40)} --stat`],
    ['an upper-case hash', 'A'.repeat(40)]
  ])('rejects %s', (_label, value) => {
    expect(isCommitSha(value)).toBe(false)
  })
})
