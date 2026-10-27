import { existsSync, readFileSync } from 'node:fs'

import { GENERATED_DOCS } from '../../scripts/lib/generated-docs.js'

// The guides every phase has to have written by its end. It starts with the ones that exist and
// grows with each phase until it is complete in Phase 9 (TDD §6.13).
const REQUIRED_GUIDES = ['docs/config-reference.md']

const read = (path: string): string => readFileSync(path, 'utf8')

describe('docs', () => {
  it.each(GENERATED_DOCS.map(doc => [doc.path, doc] as const))(
    '%s equals a fresh generation',
    (_path, doc) => {
      expect(read(doc.path)).toBe(doc.render())
    }
  )

  it.each(REQUIRED_GUIDES)('%s exists', path => {
    expect(existsSync(path)).toBe(true)
  })

  it.each(REQUIRED_GUIDES)('%s has no TODO or TBD left in it', path => {
    expect(read(path)).not.toMatch(/\b(TODO|TBD)\b/i)
  })
})
