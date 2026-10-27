import { envSchema } from '../../src/config/env.schema.js'

import { renderConfigReference } from './config-reference.js'

function rowOf(name: string): string {
  const row = renderConfigReference()
    .split('\n')
    .find(line => line.startsWith(`| \`${name}\` |`))
  if (row === undefined) throw new Error(`${name} has no row`)
  return row
}

describe('renderConfigReference', () => {
  it('describes a bounded integer by its range and a variable with a default as optional', () => {
    expect(rowOf('PORT')).toContain('| integer, 1 to 65535 | no | `3000` |')
  })

  it('describes an integer without an upper bound by its minimum only', () => {
    expect(rowOf('MAX_SESSIONS')).toContain('| integer, 1 or more | no | `10` |')
  })

  it('describes a fraction by its range', () => {
    expect(rowOf('WARMUP_START_FRACTION')).toContain('| number, 0 to 1 | no | `0.1` |')
  })

  it('shows the default of a boolean variable', () => {
    expect(rowOf('STORE_MESSAGE_BODIES')).toContain('| `true`, `false` | no | `true` |')
  })

  it('marks a variable with neither default nor optionality as required', () => {
    expect(rowOf('ADMIN_API_KEY')).toContain('| yes |')
  })

  it('describes an enum, a URL, a text, a list and a string default', () => {
    expect(rowOf('LOG_LEVEL')).toContain('`fatal`, `error`')
    expect(rowOf('PROXY_URL')).toContain('| URL | no |  |')
    expect(rowOf('ADMIN_API_KEY')).toContain('string, 32 characters or more')
    expect(rowOf('DEVICE_NAME')).toContain('string, 1 character or more')
    expect(rowOf('CORS_ORIGINS')).toContain('| string | no |  |')
    expect(rowOf('WWEBJS_DATA_PATH')).toContain('`./.wwebjs_auth`')
    expect(rowOf('API_KEY_MAX_TTL_DAYS')).toContain('| integer, 0 or more | no | `0` |')
  })

  it('has exactly one row per variable of the schema', () => {
    const names = renderConfigReference()
      .split('\n')
      .flatMap(line => /^\| `([A-Z0-9_]+)` \|/.exec(line)?.[1] ?? [])

    expect(names).toEqual(Object.keys(envSchema.shape))
  })

  it('requires exactly the four variables without default', () => {
    const required = renderConfigReference()
      .split('\n')
      .filter(line => line.split(' | ')[2] === 'yes')
      .map(line => /^\| `([A-Z0-9_]+)`/.exec(line)?.[1])

    expect(required).toEqual(['PUBLIC_BASE_URL', 'DATABASE_URL', 'REDIS_URL', 'ADMIN_API_KEY'])
  })
})
