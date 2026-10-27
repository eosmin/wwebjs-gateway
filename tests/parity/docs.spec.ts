import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { findAdrProblems } from '../../scripts/lib/adr.js'
import { GENERATED_DOCS } from '../../scripts/lib/generated-docs.js'

// The guides every phase has to have written by its end. It starts with the ones that exist and
// grows with each phase until it is complete in Phase 9 (TDD §6.13).
const REQUIRED_GUIDES = ['docs/config-reference.md', 'docs/errors.md']

const read = (path: string): string => readFileSync(path, 'utf8')

const ADR_DIRECTORY = 'docs/adr'
const ADR_FILES = readdirSync(ADR_DIRECTORY)
  .filter(file => /^\d{4}-.+\.md$/.test(file))
  .sort()

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

describe('architecture decision records', () => {
  it('has at least the records of Phase 0', () => {
    expect(ADR_FILES.length).toBeGreaterThanOrEqual(4)
  })

  it('numbers them 0001, 0002, ... with no gap and no repeat', () => {
    expect(ADR_FILES.map(file => file.slice(0, 4))).toEqual(
      ADR_FILES.map((_file, index) => String(index + 1).padStart(4, '0'))
    )
  })

  it.each(ADR_FILES)('%s is listed in the index of the folder', file => {
    expect(read(`${ADR_DIRECTORY}/README.md`)).toContain(`(${file})`)
  })

  it.each(ADR_FILES)('%s follows the template', file => {
    expect(findAdrProblems(file, read(`${ADR_DIRECTORY}/${file}`))).toEqual([])
  })

  // ADR 0003 describes the ruleset in prose; the file is what GitHub is given
  it('the ruleset file says what ADR 0003 says', () => {
    const ruleset = JSON.parse(read('deploy/github-ruleset.json')) as {
      bypass_actors: unknown[]
      rules: { type: string; parameters?: Record<string, unknown> }[]
    }
    const rule = (type: string): Record<string, unknown> | undefined =>
      ruleset.rules.find(candidate => candidate.type === type)?.parameters
    const checks = rule('required_status_checks')?.['required_status_checks'] as
      { context: string; integration_id: number }[] | undefined

    expect(ruleset.bypass_actors).toEqual([])
    expect(ruleset.rules.map(candidate => candidate.type)).toEqual(
      expect.arrayContaining(['deletion', 'non_fast_forward', 'required_linear_history'])
    )
    expect(rule('pull_request')).toMatchObject({
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
      allowed_merge_methods: ['squash']
    })
    // 15368 is the GitHub Actions app: no other app can report a check with these names
    expect(checks?.every(check => check.integration_id === 15368)).toBe(true)
    expect(checks?.map(check => check.context)).toEqual([
      'lint-and-types',
      'unit-tests',
      'integration-tests',
      'security-scan'
    ])
  })
})
