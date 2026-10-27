import { z } from 'zod'

import { findEnvExampleProblems } from './env-example.js'

const schema = z.object({
  REQUIRED_KEY: z.string(),
  OPTIONAL_KEY: z.string().default('x'),
  NUMBER_KEY: z.coerce.number().int().default(1)
})

const lines = (...entries: string[]): string => `${entries.join('\n')}\n`
const COMPLETE = ['REQUIRED_KEY=a', 'OPTIONAL_KEY=b', 'NUMBER_KEY=2']
const without = (key: string): string[] => COMPLETE.filter(line => !line.startsWith(`${key}=`))

describe('findEnvExampleProblems', () => {
  it('accepts a file that declares every key of the schema', () => {
    expect(findEnvExampleProblems(schema, lines(...COMPLETE))).toEqual([])
  })

  it('accepts a commented-out key that the schema accepts missing', () => {
    expect(
      findEnvExampleProblems(schema, lines(...without('OPTIONAL_KEY'), '# OPTIONAL_KEY=b'))
    ).toEqual([])
  })

  it('ignores comments that are not declarations', () => {
    expect(findEnvExampleProblems(schema, lines('# Copy me', ...COMPLETE, '# NOTE: text'))).toEqual(
      []
    )
  })

  it('reports a key of the schema that is not declared', () => {
    expect(findEnvExampleProblems(schema, lines(...without('OPTIONAL_KEY')))).toEqual([
      'OPTIONAL_KEY is in the schema but not declared in .env.example'
    ])
  })

  it('reports a key that the schema does not know', () => {
    expect(findEnvExampleProblems(schema, lines(...COMPLETE, 'EXTRA_KEY=c'))).toEqual([
      'EXTRA_KEY is declared in .env.example but not in the schema'
    ])
  })

  it('reports a key declared twice', () => {
    expect(findEnvExampleProblems(schema, lines(...COMPLETE, 'REQUIRED_KEY=b'))).toEqual([
      'REQUIRED_KEY is declared twice'
    ])
  })

  it('reports a required key that is commented out', () => {
    expect(
      findEnvExampleProblems(schema, lines(...without('REQUIRED_KEY'), '# REQUIRED_KEY=a'))
    ).toEqual(['REQUIRED_KEY is commented out, but the schema does not accept it missing'])
  })

  it('reports a declared value that the schema rejects', () => {
    expect(
      findEnvExampleProblems(schema, lines(...without('NUMBER_KEY'), 'NUMBER_KEY=abc'))
    ).toEqual([expect.stringMatching(/^NUMBER_KEY=abc is not valid: /)])
  })

  it('reads a file that was checked out with Windows line endings', () => {
    expect(findEnvExampleProblems(schema, COMPLETE.join('\r\n'))).toEqual([])
  })

  it('reads a quoted value the way an .env loader does', () => {
    expect(
      findEnvExampleProblems(schema, lines(...without('NUMBER_KEY'), 'NUMBER_KEY="2"'))
    ).toEqual([])
  })

  it('does not validate the value of a commented-out key', () => {
    expect(
      findEnvExampleProblems(schema, lines(...without('NUMBER_KEY'), '# NUMBER_KEY=abc'))
    ).toEqual([])
  })
})
