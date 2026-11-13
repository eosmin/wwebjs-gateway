import { buildLabel } from './wa-web-build.js'

describe('buildLabel', () => {
  it('keeps a version of the form 2.3000.<number>', () => {
    expect(buildLabel('2.3000.1054292354')).toBe('2.3000.1054292354')
    expect(buildLabel('2.3000.0')).toBe('2.3000.0')
    expect(buildLabel('  2.3000.1054292354 ')).toBe('2.3000.1054292354')
  })

  it.each([
    undefined,
    '',
    'unknown',
    '2.3001.1',
    '3.3000.1',
    '2.3000.',
    '2.3000.1-alpha',
    '2.3000.1\n2',
    '2.3000.x',
    `2.3000.${'1'.repeat(21)}`,
    '15551234567@c.us',
    'https://web.whatsapp.com/'
  ])('answers unknown for %j, so a label cannot grow without a bound', value => {
    expect(buildLabel(value)).toBe('unknown')
  })
})
