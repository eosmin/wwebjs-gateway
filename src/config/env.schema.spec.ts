import { envSchema } from './env.schema.js'

const valid = {
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_API_KEY: 'a'.repeat(32),
  METRICS_TOKEN: 'metrics-token'
}

describe('envSchema', () => {
  it('fills the defaults of the optional variables', () => {
    const env = envSchema.parse(valid)

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info'
    })
  })

  it.each(['postgres://h/db', 'postgresql://h/db'])('accepts the DATABASE_URL %s', url => {
    expect(envSchema.safeParse({ ...valid, DATABASE_URL: url }).success).toBe(true)
  })

  it.each(['redis://h:6379', 'rediss://h:6380'])('accepts the REDIS_URL %s', url => {
    expect(envSchema.safeParse({ ...valid, REDIS_URL: url }).success).toBe(true)
  })

  it.each(['development', 'test', 'production'])('accepts NODE_ENV=%s', nodeEnv => {
    expect(envSchema.parse({ ...valid, NODE_ENV: nodeEnv }).NODE_ENV).toBe(nodeEnv)
  })

  it.each(['1', '65535'])('accepts the PORT %s at the edge of the range', port => {
    expect(envSchema.parse({ ...valid, PORT: port }).PORT).toBe(Number(port))
  })

  it('coerces PORT from the string an environment provides', () => {
    expect(envSchema.parse({ ...valid, PORT: '8080' }).PORT).toBe(8080)
  })

  it('trims the secrets, so that a trailing newline is not counted toward their length', () => {
    const env = envSchema.parse({
      ...valid,
      ADMIN_API_KEY: `${'a'.repeat(32)}\n`,
      METRICS_TOKEN: ' t\n'
    })

    expect(env.ADMIN_API_KEY).toBe('a'.repeat(32))
    expect(env.METRICS_TOKEN).toBe('t')
  })

  it.each([
    ['a PORT out of range', { PORT: '70000' }],
    ['a PORT just above the range', { PORT: '65536' }],
    ['a PORT of zero', { PORT: '0' }],
    ['a PORT with decimals', { PORT: '3000.5' }],
    ['a PORT that is not a number', { PORT: 'abc' }],
    ['a NODE_ENV that is not a mode', { NODE_ENV: 'prod' }],
    [
      'an ADMIN_API_KEY of 31 characters followed by a newline',
      { ADMIN_API_KEY: `${'a'.repeat(31)}\n` }
    ],
    ['a METRICS_TOKEN of only whitespace', { METRICS_TOKEN: ' ' }],
    ['a DATABASE_URL that is not a PostgreSQL URL', { DATABASE_URL: 'http://localhost/db' }],
    ['a REDIS_URL that is not a Redis URL', { REDIS_URL: 'https://localhost' }],
    ['an unknown LOG_LEVEL', { LOG_LEVEL: 'loud' }],
    ['an ADMIN_API_KEY shorter than 32 characters', { ADMIN_API_KEY: 'short' }],
    ['an empty METRICS_TOKEN', { METRICS_TOKEN: '' }],
    ['a DATABASE_URL that is not a URL', { DATABASE_URL: 'not a url' }]
  ])('rejects %s', (_label, override) => {
    expect(envSchema.safeParse({ ...valid, ...override }).success).toBe(false)
  })

  it.each(['DATABASE_URL', 'REDIS_URL', 'ADMIN_API_KEY', 'METRICS_TOKEN'] as const)(
    'requires %s',
    key => {
      const rest = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))

      expect(envSchema.safeParse(rest).success).toBe(false)
    }
  )
})
