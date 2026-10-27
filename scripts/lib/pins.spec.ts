import { findUnpinnedDependencies } from './pins.js'

describe('findUnpinnedDependencies', () => {
  it('accepts exact versions in every group that is installed', () => {
    expect(
      findUnpinnedDependencies({
        dependencies: { zod: '4.6.7' },
        devDependencies: { prettier: '3.9.6' },
        optionalDependencies: { fsevents: '2.3.3' }
      })
    ).toEqual([])
  })

  it('accepts a pre-release and build metadata, which are still exact', () => {
    expect(
      findUnpinnedDependencies({
        dependencies: { a: '8.0.0-rc.27', b: '1.2.3+build.5' }
      })
    ).toEqual([])
  })

  it('accepts a package.json with no dependencies at all', () => {
    expect(findUnpinnedDependencies({})).toEqual([])
  })

  it.each([
    ['a caret range', '^4.6.7'],
    ['a tilde range', '~4.6.7'],
    ['a comparison', '>=4.6.7'],
    ['a wildcard', '4.x'],
    ['a partial version', '4.6'],
    ['a tag', 'latest'],
    ['a star', '*'],
    ['an alias to a range', 'npm:zod@^4.6.7'],
    ['a git URL', 'github:owner/repo#main'],
    ['a local path', 'file:../x'],
    ['an empty string', '']
  ])('reports %s', (_label, range) => {
    expect(findUnpinnedDependencies({ dependencies: { zod: range } })).toEqual([
      `dependencies.zod is "${range}", which is not an exact version`
    ])
  })

  it('names the group of each offender, in a stable order', () => {
    expect(
      findUnpinnedDependencies({
        devDependencies: { b: '^1.0.0' },
        dependencies: { a: '~2.0.0' }
      })
    ).toEqual([
      'dependencies.a is "~2.0.0", which is not an exact version',
      'devDependencies.b is "^1.0.0", which is not an exact version'
    ])
  })

  it('leaves peerDependencies alone: a peer range is how a library says what it supports', () => {
    expect(findUnpinnedDependencies({ peerDependencies: { react: '^19.0.0' } })).toEqual([])
  })
})
