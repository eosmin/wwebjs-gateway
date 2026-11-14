// What marks a document as unfinished (TDD §6.13, docs test 3): a placeholder word, or a code block
// with nothing in it
const PLACEHOLDER_WORDS = /\b(TODO|TBD|FIXME|lorem)\b/i

// Fences are paired line by line: a block opens on a run of three or more backticks or tildes and
// closes on a run of the same character that is at least as long
function hasEmptyCodeBlock(text: string): boolean {
  let open: { marker: string; length: number; content: boolean } | undefined

  for (const line of text.split(/\r?\n/)) {
    const fence = /^ {0,12}(`{3,}|~{3,})(.*)$/.exec(line)
    const marker = fence?.[1]
    if (open === undefined) {
      if (marker !== undefined)
        open = { marker: marker[0] ?? '', length: marker.length, content: false }
    } else if (
      marker !== undefined &&
      marker[0] === open.marker &&
      marker.length >= open.length &&
      (fence?.[2] ?? '').trim() === ''
    ) {
      if (!open.content) return true
      open = undefined
    } else if (line.trim() !== '') {
      open.content = true
    }
  }
  return false
}

export function findPlaceholders(file: string, text: string): string[] {
  const problems: string[] = []
  const word = PLACEHOLDER_WORDS.exec(text)

  if (word !== null) problems.push(`${file}: "${word[0]}" is left in it`)
  if (hasEmptyCodeBlock(text)) problems.push(`${file}: it has an empty code block`)
  return problems
}
