import { anchorsOf, findBrokenLinks, internalLinks, slugify } from './doc-links.js'

const files: Record<string, string> = {
  'README.md': '# Title\n',
  'docs/a.md': '# A\n\n## Send `text` now\n\n## Repeat\n\n## Repeat\n',
  'docs/b.md': '# B\n'
}
const fs = {
  exists: (path: string): boolean => path in files,
  read: (path: string): string => files[path] ?? ''
}

describe('slugify and anchorsOf', () => {
  it('follows the GitHub rule', () => {
    expect(slugify('Send `text` now!')).toBe('send-text-now')
    expect(slugify('Why  not?')).toBe('why--not')
  })

  it('does not take a closing run of hashes for the heading, unless a space sets it apart', () => {
    expect(anchorsOf('# Why C#\n## Closed ##\n')).toEqual(new Set(['why-c', 'closed']))
  })

  it('numbers a repeated heading and ignores the ones in code blocks', () => {
    expect(anchorsOf('# A\n## Repeat\n## Repeat\n```\n# not a heading\n```\n')).toEqual(
      new Set(['a', 'repeat', 'repeat-1'])
    )
  })
})

describe('internalLinks', () => {
  it('returns relative and anchor links, not external ones nor the ones in code', () => {
    const text = [
      '  ```md',
      '  [e](e.md)',
      '  ```',
      '````md',
      '```',
      '[f](f.md)',
      '```',
      '````',
      '[a](docs/a.md) [b](#top) ![i](img.png) [web](https://x.dev) [mail](mailto:a@b.c)',
      '`[c](c.md)`',
      '```',
      '[d](d.md)',
      '```'
    ].join('\n')

    expect(internalLinks(text)).toEqual(['docs/a.md', '#top', 'img.png'])
  })
})

describe('findBrokenLinks', () => {
  it('accepts links to files and to headings that exist', () => {
    const text = '[a](docs/a.md) [h](docs/a.md#send-text-now) [r](docs/a.md#repeat-1) [s](#title)'

    expect(findBrokenLinks('README.md', text, fs)).toEqual([])
  })

  it('resolves a link from the folder of the file that holds it', () => {
    expect(findBrokenLinks('docs/a.md', '[b](b.md) [r](../README.md)', fs)).toEqual([])
  })

  it('reports a file that is not there', () => {
    expect(findBrokenLinks('README.md', '[x](docs/gone.md)', fs)).toEqual([
      'README.md: docs/gone.md points to a file that is not there'
    ])
  })

  it('reports a heading that is not there', () => {
    expect(findBrokenLinks('README.md', '[x](docs/a.md#nope) [y](#nope)', fs)).toEqual([
      'README.md: docs/a.md#nope points to a heading that is not there',
      'README.md: #nope points to a heading that is not there'
    ])
  })

  it('reports a link whose escape is malformed instead of throwing', () => {
    expect(findBrokenLinks('README.md', '[x](docs/a.md#100%) [y](docs/%zz.md)', fs)).toEqual([
      'README.md: docs/a.md#100% is not a valid link',
      'README.md: docs/%zz.md is not a valid link'
    ])
  })

  it('reads a link that starts with a slash from the root of the repository', () => {
    expect(findBrokenLinks('docs/a.md', '[r](/README.md) [b](/docs/b.md)', fs)).toEqual([])
    expect(findBrokenLinks('docs/a.md', '[r](/docs/gone.md)', fs)).toHaveLength(1)
  })

  it('reports a link that climbs out of the repository', () => {
    expect(findBrokenLinks('README.md', '[x](../outside.md)', fs)).toHaveLength(1)
  })
})
