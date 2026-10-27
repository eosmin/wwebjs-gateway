import { isDocsOnly } from './affected.js'

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
