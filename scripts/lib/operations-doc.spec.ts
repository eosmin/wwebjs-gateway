import { cell } from './operations-doc.js'

describe('cell', () => {
  it('keeps plain text as it is', () => {
    expect(cell('Send a text message to a chat')).toBe('Send a text message to a chat')
  })

  it('escapes the pipe that would end the cell', () => {
    expect(cell('a | b')).toBe('a \\| b')
  })

  it('folds a line break into a space', () => {
    expect(cell('first\n  second\r\nthird')).toBe('first second third')
  })

  it.each([
    ['a backtick that would open a code span', 'use `x', 'use \\`x'],
    ['a backtick left unbalanced after a code span', '`a` and `b', '`a` and \\`b'],
    ['an angle bracket that would open an HTML tag', 'a <b> c', 'a \\<b\\> c'],
    ['a square bracket that would open a link', 'see [here](x)', 'see \\[here\\](x)']
  ])('escapes %s', (_what, text, expected) => {
    expect(cell(text)).toBe(expected)
  })

  it('keeps a balanced code span as code, escaping only its pipe', () => {
    expect(cell('an id is `user@server` or `a|b`')).toBe('an id is `user@server` or `a\\|b`')
  })

  it('does not let a tag or a link inside a code span be escaped, it is literal there', () => {
    expect(cell('call `<id>` and `[x]`')).toBe('call `<id>` and `[x]`')
  })

  it('escapes the backslash first, so an escape written by the author stays literal', () => {
    expect(cell('a \\| b')).toBe('a \\\\\\| b')
  })

  it('leaves no unescaped pipe, backtick, angle or square bracket in what it returns', () => {
    const out = cell('x | `y` <z> [w] \\ \n end `')

    expect(out.replace(/`y`|\\./g, '')).not.toMatch(/[|`<>[\]\n]/)
  })
})
