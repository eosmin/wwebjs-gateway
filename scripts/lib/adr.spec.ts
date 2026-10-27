import { findAdrProblems } from './adr.js'

const VALID = [
  '# ADR 0007: A decision',
  '',
  'Status: Accepted (2026-10-27)',
  '',
  '## Context',
  'why',
  '',
  '## Decision',
  'what',
  '',
  '## Consequences',
  'so',
  '',
  '## Alternatives considered',
  'or',
  ''
].join('\n')

const check = (text: string): string[] => findAdrProblems('0007-a-decision.md', text)

describe('findAdrProblems', () => {
  it('accepts a record that follows the template', () => {
    expect(check(VALID)).toEqual([])
  })

  it('accepts the same record saved with Windows line endings', () => {
    expect(check(VALID.replaceAll('\n', '\r\n'))).toEqual([])
  })

  it('accepts a superseded status', () => {
    expect(check(VALID.replace('Accepted', 'Superseded by ADR 0009'))).toEqual([])
  })

  it('reports a title whose number is not the number of the file', () => {
    expect(check(VALID.replace('ADR 0007', 'ADR 0008'))).toEqual([
      'the title must be "# ADR 0007: <title>"'
    ])
  })

  it('reports a missing or malformed status line', () => {
    expect(check(VALID.replace('Status: Accepted (2026-10-27)', 'Status: maybe'))).toEqual([
      'the status line must be "Status: Accepted (YYYY-MM-DD)" or "Status: Superseded by ADR NNNN (YYYY-MM-DD)"'
    ])
  })

  it.each(['Context', 'Decision', 'Consequences', 'Alternatives considered'])(
    'reports a missing "## %s" heading',
    heading => {
      expect(check(VALID.replace(`## ${heading}`, `### ${heading}`))).toEqual([
        `the heading "## ${heading}" must appear exactly once`
      ])
    }
  )

  it('reports a heading that appears twice', () => {
    expect(check(`${VALID}\n## Decision\nagain\n`)).toEqual([
      'the heading "## Decision" must appear exactly once'
    ])
  })

  it('reports headings out of order', () => {
    const swapped = VALID.replace('## Decision', '## TMP')
      .replace('## Consequences', '## Decision')
      .replace('## TMP', '## Consequences')

    expect(check(swapped)).toEqual([
      'the headings must come in this order: Context, Decision, Consequences, Alternatives considered'
    ])
  })

  it('does not count a heading that only appears inside a code block', () => {
    const quoted = VALID.replace('## Decision', '```markdown\n## Decision\n```')

    expect(check(quoted)).toEqual(['the heading "## Decision" must appear exactly once'])
  })
})
