import { formatStartupFailure } from './startup-failure.js'

describe('formatStartupFailure', () => {
  it('writes one JSON line with the reason and a fatal level', () => {
    const line = formatStartupFailure(new Error('Redis is not reachable'))

    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({
      level: 'fatal',
      msg: 'Startup failed: Redis is not reachable'
    })
  })

  it('keeps the credentials of a connection string out of the line, from the driver or from Prisma', () => {
    const driver = formatStartupFailure(
      new Error('connect failed for postgresql://gateway:hunter2-not-real@db.internal:5432/gateway')
    )
    const redis = formatStartupFailure(
      new Error('could not reach redis://default:hunter2-not-real@cache:6379')
    )

    expect(driver).not.toContain('hunter2-not-real')
    expect(redis).not.toContain('hunter2-not-real')
    expect(driver).toContain('db.internal')
  })

  it('keeps a key or a token that the message quotes out of the line', () => {
    const line = formatStartupFailure(
      new Error('bad header Authorization: Bearer abc.def.ghi, key wgk_AAAABBBBCCCC')
    )

    expect(line).not.toContain('abc.def.ghi')
    expect(line).not.toContain('wgk_AAAABBBBCCCC')
  })

  it('answers for a value that is not an Error too', () => {
    expect(formatStartupFailure('redis://u:secret-not-real@h')).not.toContain('secret-not-real')
  })
})
