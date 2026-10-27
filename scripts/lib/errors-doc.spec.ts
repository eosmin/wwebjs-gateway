import { ERROR_DEFINITIONS, ErrorCode } from '../../src/common/errors.js'

import { renderErrors, statusName } from './errors-doc.js'

describe('renderErrors', () => {
  const doc = renderErrors()
  const rows = doc.split('\n').filter(line => /^\| `[A-Z_]+` \|/.test(line))

  it('has one row per error code, none twice', () => {
    const codes = rows.map(row => /^\| `([A-Z_]+)`/.exec(row)?.[1])

    expect([...codes].sort()).toEqual(Object.values(ErrorCode).sort())
  })

  it.each(Object.entries(ERROR_DEFINITIONS))(
    '%s carries its status and its meaning',
    (code, def) => {
      expect(rows).toContain(
        `| \`${code}\` | ${def.status} ${statusName(def.status)} | ${def.meaning} |`
      )
    }
  )

  it('lists the codes by ascending status', () => {
    const statuses = rows.map(row => Number(/\| (\d{3}) /.exec(row)?.[1]))

    expect(statuses).toHaveLength(Object.values(ErrorCode).length)
    expect(statuses.every(Number.isInteger)).toBe(true)
    expect(statuses).toEqual([...statuses].sort((a, b) => a - b))
  })

  it('shows the body every error answers with', () => {
    expect(doc).toContain('"error": { "code": "SESSION_NOT_READY"')
  })
})

describe('statusName', () => {
  it.each([
    [401, 'Unauthorized'],
    [409, 'Conflict'],
    [422, 'Unprocessable Entity'],
    [502, 'Bad Gateway'],
    [504, 'Gateway Timeout']
  ])('names %d %s', (status, name) => {
    expect(statusName(status)).toBe(name)
  })

  it('falls back to the number when the status has no name', () => {
    expect(statusName(599)).toBe('599')
  })
})
