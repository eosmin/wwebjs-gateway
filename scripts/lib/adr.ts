// In this order: a reader finds the same four questions answered in every record
const HEADINGS = ['Context', 'Decision', 'Consequences', 'Alternatives considered']

const STATUS = /^Status: (Accepted|Superseded by ADR \d{4}) \(\d{4}-\d{2}-\d{2}\)$/m

// A fenced block can quote a whole template, as docs/adr/README.md does, and those lines are not the
// record's own
function withoutCodeBlocks(text: string): string {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '')
}

// What is wrong with an architecture decision record, empty when it follows the template
export function findAdrProblems(file: string, text: string): string[] {
  const number = file.slice(0, 4)
  const body = withoutCodeBlocks(text.replaceAll('\r\n', '\n'))
  const problems: string[] = []

  if (!new RegExp(`^# ADR ${number}: .+`).test(body)) {
    problems.push(`the title must be "# ADR ${number}: <title>"`)
  }
  if (!STATUS.test(body)) {
    problems.push(
      'the status line must be "Status: Accepted (YYYY-MM-DD)" or "Status: Superseded by ADR NNNN (YYYY-MM-DD)"'
    )
  }

  const positions = HEADINGS.map(heading =>
    [...body.matchAll(new RegExp(`^## ${heading}$`, 'gm'))].map(match => match.index)
  )
  HEADINGS.forEach((heading, index) => {
    if (positions[index]?.length !== 1) {
      problems.push(`the heading "## ${heading}" must appear exactly once`)
    }
  })
  // The order only means something once every heading is there exactly once
  if (positions.every(found => found.length === 1)) {
    const first = positions.map(found => found[0] ?? -1)
    if (first.some((position, index) => index > 0 && position < (first[index - 1] ?? -1))) {
      problems.push(`the headings must come in this order: ${HEADINGS.join(', ')}`)
    }
  }
  return problems
}
