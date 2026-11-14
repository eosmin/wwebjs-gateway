import { findPlaceholders } from './doc-placeholders.js'

describe('findPlaceholders', () => {
  it('accepts a finished guide', () => {
    expect(findPlaceholders('a.md', '# A\n\n```bash\ncurl x\n```\n\nDone.\n')).toEqual([])
  })

  it.each(['TODO', 'tbd', 'FIXME', 'Lorem ipsum'])('reports %s', word => {
    expect(findPlaceholders('a.md', `# A\n\n${word} later\n`)).toEqual([
      expect.stringContaining('is left in it')
    ])
  })

  it('does not take a word that contains one for the placeholder', () => {
    expect(findPlaceholders('a.md', 'a todolist and a tbdx\n')).toEqual([])
  })

  it.each(['```\n```', '```bash\n\n  \n```', '~~~\n~~~', '````\n````'])(
    'reports an empty code block: %j',
    block => {
      expect(findPlaceholders('a.md', `# A\n\n${block}\n`)).toEqual([
        'a.md: it has an empty code block'
      ])
    }
  )

  it('does not report two blocks that only look like one empty block', () => {
    expect(findPlaceholders('a.md', '```\nx\n```\n\n```\ny\n```\n')).toEqual([])
  })
})
