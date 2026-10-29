import { envSchema, parseEnv } from './env.schema.js'

const valid = {
  PUBLIC_BASE_URL: 'https://gateway.example.com',
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_API_KEY: 'a'.repeat(32),
  METRICS_TOKEN: 'm'.repeat(32)
}

// Every default of TDD §6.15, so that a typo in any of them fails here
const DEFAULTS = {
  NODE_ENV: 'development',
  HOST: '0.0.0.0',
  PORT: 3000,
  LOG_LEVEL: 'info',
  API_KEY_ROTATION_GRACE_MINUTES: 10,
  API_KEY_MAX_TTL_DAYS: 0,
  TRUST_PROXY_HOPS: 0,
  BULL_BOARD_ENABLED: false,
  CORS_ORIGINS: [],
  RATE_LIMIT_MAX: 300,
  WWEBJS_DATA_PATH: './.wwebjs_auth',
  WWEB_VERSION_CACHE_TYPE: 'local',
  WWEB_CACHE_PATH: './.wwebjs_cache',
  WWEB_VERSION_STRICT: true,
  QR_MAX_RETRIES: 6,
  TAKEOVER_ON_CONFLICT: false,
  WA_CALL_TIMEOUT_MS: 60000,
  MAX_SESSIONS: 10,
  SESSION_START_STAGGER_MS: 5000,
  SESSION_START_TIMEOUT_MS: 180000,
  SESSION_RECONNECT_MAX_ATTEMPTS: 0,
  WATCHDOG_INTERVAL_MS: 30000,
  WATCHDOG_MAX_FAILURES: 3,
  MEMORY_RESTART_THRESHOLD_MB: 0,
  INBOUND_ORDERING_ENABLED: true,
  INBOUND_LATE_THRESHOLD_S: 3,
  INBOUND_ORDER_WINDOW_MS: 1500,
  INBOUND_ORDER_MAX_HOLD_MS: 5000,
  INBOUND_ORDER_MAX_MESSAGES: 200,
  MESSAGE_BATCH_ENABLED: true,
  RECONCILE_ON_READY: true,
  RECONCILE_MAX_CHATS: 50,
  RECONCILE_FETCH_LIMIT: 50,
  RECONCILE_LOOKBACK_HOURS: 48,
  INCLUDE_RAW: true,
  RAW_MAX_FIELD_BYTES: 8192,
  SEND_MIN_INTERVAL_MS: 1000,
  SEND_JITTER_MS: 400,
  SEND_SYNC_TIMEOUT_MS: 60000,
  SEND_MAX_WAIT_MS: 300000,
  SEND_NOT_READY_RETRY_MS: 5000,
  SEND_BREAKER_THRESHOLD: 5,
  SEND_BREAKER_COOLDOWN_MS: 60000,
  MAX_MEDIA_BYTES: 33554432,
  CONVERSATION_WINDOW_HOURS: 24,
  ALLOW_COLD_SENDS: false,
  COLD_SENDS_PER_DAY: 20,
  COLD_SEND_MIN_GAP_MS: 60000,
  LOOKUPS_PER_DAY: 100,
  PER_CHAT_MIN_INTERVAL_MS: 1500,
  PER_CHAT_MAX_PER_MINUTE: 10,
  SESSION_MAX_PER_MINUTE: 20,
  SESSION_MAX_PER_HOUR: 300,
  SESSION_MAX_PER_DAY: 1500,
  DUPLICATE_RECIPIENTS_THRESHOLD: 5,
  DUPLICATE_WINDOW_MINUTES: 10,
  WARMUP_DAYS: 14,
  WARMUP_START_FRACTION: 0.1,
  UNREACHABLE_STREAK: 5,
  UNREACHABLE_MIN_AGE_HOURS: 72,
  SEND_POLICY_MAX_WAIT_MS: 1800000,
  HEALTH_WINDOW: 50,
  HEALTH_MIN_SAMPLES: 10,
  HEALTH_MAX_BAD_RATIO: 0.2,
  HEALTH_COOLDOWN_MIN: 30,
  HUMANIZE_MIN_REPLY_DELAY_MS: 1500,
  EVENT_REPLAY_WINDOW_SECONDS: 300,
  WEBHOOK_TIMEOUT_MS: 10000,
  WEBHOOK_MAX_ATTEMPTS: 10,
  WEBHOOK_BACKOFF_MS: 5000,
  WEBHOOK_WORKER_CONCURRENCY: 10,
  WEBHOOK_INLINE_MEDIA_MAX_BYTES: 5242880,
  WEBHOOK_PRIVATE_HOST_ALLOWLIST: [],
  ALLOW_PRIVATE_WEBHOOK_TARGETS: false,
  CALL_CACHE_SIZE: 50,
  DELIVERY_RETENTION_DAYS: 14,
  MESSAGE_RETENTION_DAYS: 30,
  STORE_MESSAGE_BODIES: true
}

describe('envSchema', () => {
  it('fills every default of TDD §6.15 and nothing else', () => {
    const { PUBLIC_BASE_URL, DATABASE_URL, REDIS_URL, ADMIN_API_KEY, METRICS_TOKEN, ...defaults } =
      envSchema.parse(valid)

    expect(defaults).toStrictEqual(DEFAULTS)
    expect([PUBLIC_BASE_URL, DATABASE_URL, REDIS_URL, ADMIN_API_KEY, METRICS_TOKEN]).toEqual(
      Object.values(valid)
    )
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
      METRICS_TOKEN: ` ${'t'.repeat(32)}\n`
    })

    expect(env.ADMIN_API_KEY).toBe('a'.repeat(32))
    expect(env.METRICS_TOKEN).toBe('t'.repeat(32))
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
    ['a METRICS_TOKEN shorter than 32 characters', { METRICS_TOKEN: 'short-token' }],
    ['a METRICS_TOKEN of 31 characters', { METRICS_TOKEN: 'm'.repeat(31) }],
    ['a PUBLIC_BASE_URL that is not http(s)', { PUBLIC_BASE_URL: 'ftp://gateway.example.com' }],
    ['a DATABASE_URL that is not a URL', { DATABASE_URL: 'not a url' }]
  ])('rejects %s', (_label, override) => {
    expect(envSchema.safeParse({ ...valid, ...override }).success).toBe(false)
  })

  it.each(['PUBLIC_BASE_URL', 'DATABASE_URL', 'REDIS_URL', 'ADMIN_API_KEY'] as const)(
    'requires %s',
    key => {
      const rest = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))

      expect(envSchema.safeParse(rest).success).toBe(false)
    }
  )

  it('leaves METRICS_TOKEN and the other optional variables unset', () => {
    const env = envSchema.parse({ ...valid, METRICS_TOKEN: undefined })

    expect(env.METRICS_TOKEN).toBeUndefined()
    expect(env.PROXY_URL).toBeUndefined()
    expect(env.WWEB_VERSION).toBeUndefined()
  })

  it('reads a boolean by its spelling, so "false" is false', () => {
    const env = envSchema.parse({ ...valid, ALLOW_COLD_SENDS: 'true', INCLUDE_RAW: 'false' })

    expect(env.ALLOW_COLD_SENDS).toBe(true)
    expect(env.INCLUDE_RAW).toBe(false)
  })

  it.each(['1', 'yes', 'TRUE', ''])('rejects %j as a boolean', value => {
    expect(envSchema.safeParse({ ...valid, BULL_BOARD_ENABLED: value }).success).toBe(false)
  })

  it('splits a comma-separated list, dropping blanks, and defaults it to empty', () => {
    const env = envSchema.parse({ ...valid, CORS_ORIGINS: ' https://a.test, ,https://b.test ' })

    expect(env.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test'])
    expect(env.WEBHOOK_PRIVATE_HOST_ALLOWLIST).toEqual([])
  })

  it.each([
    ['a negative count', { QR_MAX_RETRIES: '-1' }],
    ['a count with decimals', { MAX_SESSIONS: '1.5' }],
    ['zero MAX_SESSIONS', { MAX_SESSIONS: '0' }],
    ['a fraction above 1', { WARMUP_START_FRACTION: '1.1' }],
    ['a fraction below 0', { HEALTH_MAX_BAD_RATIO: '-0.1' }],
    ['a PROXY_URL that is not a URL', { PROXY_URL: 'proxy' }],
    ['a PROXY_URL that is not http, https, socks4 or socks5', { PROXY_URL: 'ftp://proxy.test:21' }],
    [
      'a SOCKS PROXY_URL with credentials, which Chromium cannot use',
      { PROXY_URL: 'socks5://user:pass@proxy.test:1080' }
    ],
    [
      'a PROXY_URL whose credentials are not valid percent-encoding',
      { PROXY_URL: 'http://us%er:p%@proxy.test:80' }
    ],
    [
      'a remote path that is not https',
      {
        WWEB_VERSION: '2.3000.1',
        WWEB_VERSION_CACHE_TYPE: 'remote',
        WWEB_VERSION_REMOTE_PATH: 'http://h.test/{version}.html'
      }
    ],
    [
      'a remote cache without a pinned version',
      {
        WWEB_VERSION_CACHE_TYPE: 'remote',
        WWEB_VERSION_REMOTE_PATH: 'https://h.test/{version}.html'
      }
    ],
    ['an unknown WWEB_VERSION_CACHE_TYPE', { WWEB_VERSION_CACHE_TYPE: 'disk' }],
    ['a remote cache without a remote path', { WWEB_VERSION_CACHE_TYPE: 'remote' }],
    [
      'a remote path without the {version} placeholder',
      { WWEB_VERSION_CACHE_TYPE: 'remote', WWEB_VERSION_REMOTE_PATH: 'https://h.test/wa.html' }
    ],
    [
      'an order hold shorter than the window',
      { INBOUND_ORDER_WINDOW_MS: '2000', INBOUND_ORDER_MAX_HOLD_MS: '1000' }
    ]
  ])('rejects %s', (_label, override) => {
    expect(envSchema.safeParse({ ...valid, ...override }).success).toBe(false)
  })

  it.each([
    'http://proxy.test:8080',
    'https://u:p%40ss@proxy.test:8443',
    'socks5://proxy.test:1080'
  ])('accepts the proxy %s', proxy => {
    expect(envSchema.parse({ ...valid, PROXY_URL: proxy }).PROXY_URL).toBe(proxy)
  })

  it('accepts a remote cache with a path that has the {version} placeholder', () => {
    const env = envSchema.parse({
      ...valid,
      WWEB_VERSION: '2.3000.1',
      WWEB_VERSION_CACHE_TYPE: 'remote',
      WWEB_VERSION_REMOTE_PATH: 'https://h.test/{version}.html'
    })

    expect(env.WWEB_VERSION_REMOTE_PATH).toBe('https://h.test/{version}.html')
  })
})

describe('envSchema bounds and edges', () => {
  it.each([
    ['API_KEY_ROTATION_GRACE_MINUTES', 0],
    ['QR_MAX_RETRIES', 0],
    ['SEND_MIN_INTERVAL_MS', 0],
    ['WARMUP_DAYS', 0],
    ['RATE_LIMIT_MAX', 1],
    ['MAX_SESSIONS', 1],
    ['SEND_MAX_WAIT_MS', 1],
    ['WEBHOOK_MAX_ATTEMPTS', 1]
  ])('%s accepts its minimum %d and rejects one below', (key, min) => {
    expect(envSchema.safeParse({ ...valid, [key]: String(min) }).success).toBe(true)
    expect(envSchema.safeParse({ ...valid, [key]: String(min - 1) }).success).toBe(false)
  })

  it.each(['WARMUP_START_FRACTION', 'HEALTH_MAX_BAD_RATIO'])('%s accepts 0 and 1', key => {
    expect(envSchema.safeParse({ ...valid, [key]: '0' }).success).toBe(true)
    expect(envSchema.safeParse({ ...valid, [key]: '1' }).success).toBe(true)
  })

  it.each([
    'BULL_BOARD_ENABLED',
    'WWEB_VERSION_STRICT',
    'INBOUND_ORDERING_ENABLED',
    'INCLUDE_RAW',
    'STORE_MESSAGE_BODIES',
    'ENABLE_DOCS'
  ])('%s accepts only "true" or "false"', key => {
    expect(envSchema.safeParse({ ...valid, [key]: 'false' }).success).toBe(true)
    expect(envSchema.safeParse({ ...valid, [key]: '1' }).success).toBe(false)
    expect(envSchema.safeParse({ ...valid, [key]: '' }).success).toBe(false)
  })

  it.each([
    ['an empty string', '', []],
    ['only commas', ',,', []],
    ['values', 'a.test,b.test', ['a.test', 'b.test']]
  ])('reads WEBHOOK_PRIVATE_HOST_ALLOWLIST from %s', (_label, input, expected) => {
    const env = envSchema.parse({ ...valid, WEBHOOK_PRIVATE_HOST_ALLOWLIST: input })

    expect(env.WEBHOOK_PRIVATE_HOST_ALLOWLIST).toEqual(expected)
  })

  it.each(['10.0.0.0/99', 'bad host', '10.0.0.0/x'])(
    'rejects %j in WEBHOOK_PRIVATE_HOST_ALLOWLIST',
    entry => {
      expect(envSchema.safeParse({ ...valid, WEBHOOK_PRIVATE_HOST_ALLOWLIST: entry }).success).toBe(
        false
      )
    }
  )

  it('accepts hostnames, addresses and CIDRs in WEBHOOK_PRIVATE_HOST_ALLOWLIST', () => {
    const env = envSchema.parse({
      ...valid,
      WEBHOOK_PRIVATE_HOST_ALLOWLIST: 'bot,10.0.0.0/8,fd00::/8'
    })

    expect(env.WEBHOOK_PRIVATE_HOST_ALLOWLIST).toEqual(['bot', '10.0.0.0/8', 'fd00::/8'])
  })

  it.each([
    [
      'the remote cache without a path',
      { WWEB_VERSION: '2.3000.1', WWEB_VERSION_CACHE_TYPE: 'remote' },
      'WWEB_VERSION_REMOTE_PATH'
    ],
    [
      'the remote cache without a version',
      {
        WWEB_VERSION_CACHE_TYPE: 'remote',
        WWEB_VERSION_REMOTE_PATH: 'https://h.test/{version}.html'
      },
      'WWEB_VERSION'
    ],
    [
      'a remote path over plain http',
      {
        WWEB_VERSION: '2.3000.1',
        WWEB_VERSION_CACHE_TYPE: 'remote',
        WWEB_VERSION_REMOTE_PATH: 'http://h.test/{version}.html'
      },
      'WWEB_VERSION_REMOTE_PATH'
    ],
    ['a SOCKS proxy with credentials', { PROXY_URL: 'socks5://u:p@proxy.test:1080' }, 'PROXY_URL'],
    [
      'a path without the placeholder',
      { WWEB_VERSION_REMOTE_PATH: 'https://h.test/wa.html' },
      'WWEB_VERSION_REMOTE_PATH'
    ],
    [
      'a window above the default hold',
      { INBOUND_ORDER_WINDOW_MS: '6000' },
      'INBOUND_ORDER_MAX_HOLD_MS'
    ],
    [
      'a hold shorter than the window',
      { INBOUND_ORDER_WINDOW_MS: '2000', INBOUND_ORDER_MAX_HOLD_MS: '1999' },
      'INBOUND_ORDER_MAX_HOLD_MS'
    ],
    [
      'an ADMIN_API_KEY placeholder in production',
      { NODE_ENV: 'production', ADMIN_API_KEY: `replace-this-${'a'.repeat(32)}` },
      'ADMIN_API_KEY'
    ],
    [
      'a METRICS_TOKEN placeholder in production',
      { NODE_ENV: 'production', METRICS_TOKEN: 'replace-this-token-with-a-random-one' },
      'METRICS_TOKEN'
    ]
  ])('reports %s on the variable at fault', (_label, override, path) => {
    const result = envSchema.safeParse({ ...valid, ...override })

    expect(result.success).toBe(false)
    expect(result.error?.issues.map(issue => issue.path[0])).toEqual([path])
  })

  it('accepts a hold equal to the window, and the placeholders outside production', () => {
    expect(
      envSchema.safeParse({
        ...valid,
        INBOUND_ORDER_WINDOW_MS: '2000',
        INBOUND_ORDER_MAX_HOLD_MS: '2000'
      }).success
    ).toBe(true)
    expect(
      envSchema.safeParse({
        ...valid,
        ADMIN_API_KEY: `replace-this-${'a'.repeat(32)}`,
        METRICS_TOKEN: 'replace-this-token-with-a-random-one'
      }).success
    ).toBe(true)
  })

  it('accepts a placeholder-free production environment without METRICS_TOKEN', () => {
    expect(
      envSchema.safeParse({ ...valid, NODE_ENV: 'production', METRICS_TOKEN: undefined }).success
    ).toBe(true)
  })

  it('checks the {version} placeholder when a path is given with a non-remote cache', () => {
    expect(
      envSchema.safeParse({ ...valid, WWEB_VERSION_REMOTE_PATH: 'https://h.test/wa.html' }).success
    ).toBe(false)
  })
})

describe('parseEnv', () => {
  it('turns docs on outside production and off in production', () => {
    expect(parseEnv({ ...valid, NODE_ENV: 'development' }).ENABLE_DOCS).toBe(true)
    expect(parseEnv({ ...valid, NODE_ENV: 'production' }).ENABLE_DOCS).toBe(false)
  })

  it('lets ENABLE_DOCS override the default of the mode', () => {
    expect(parseEnv({ ...valid, NODE_ENV: 'production', ENABLE_DOCS: 'true' }).ENABLE_DOCS).toBe(
      true
    )
  })

  it('lists every invalid variable in one error', () => {
    expect(() => parseEnv({ ...valid, PORT: 'x', REDIS_URL: 'y' })).toThrow(
      /PORT:[\s\S]*REDIS_URL:/
    )
  })

  it('treats a variable set to an empty value as unset', () => {
    const env = parseEnv({
      ...valid,
      QR_MAX_RETRIES: '',
      SEND_MIN_INTERVAL_MS: ' ',
      WARMUP_START_FRACTION: '',
      PROXY_URL: '',
      CORS_ORIGINS: ''
    })

    expect(env).toMatchObject({
      QR_MAX_RETRIES: 6,
      SEND_MIN_INTERVAL_MS: 1000,
      WARMUP_START_FRACTION: 0.1,
      CORS_ORIGINS: []
    })
    expect(env.PROXY_URL).toBeUndefined()
  })

  it('never echoes a rejected value, and drops the variables it does not know', () => {
    let message = ''
    try {
      parseEnv({ ...valid, ADMIN_API_KEY: 'short-secret' })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }

    expect(message).toContain('ADMIN_API_KEY')
    expect(message).not.toContain('short-secret')
    const password = 'hunter2-secret'
    expect(() => parseEnv({ ...valid, DATABASE_URL: `mysql://u:${password}@h/db` })).toThrow(
      /DATABASE_URL/
    )
    try {
      parseEnv({ ...valid, DATABASE_URL: `mysql://u:${password}@h/db`, LOG_LEVEL: 'loud-secret' })
    } catch (error) {
      const text = error instanceof Error ? error.message : ''
      expect(text).not.toContain(password)
      expect(text).not.toContain('loud-secret')
    }
    expect(parseEnv({ ...valid, UNRELATED: 'x' })).not.toHaveProperty('UNRELATED')
  })

  it.each(['ADMIN_API_KEY', 'DATABASE_URL'])('reports an empty %s as missing', key => {
    expect(() => parseEnv({ ...valid, [key]: '' })).toThrow(
      new RegExp(`${key}: .*received undefined`)
    )
  })

  it.each([
    ['HEALTH_WINDOW', 10_001],
    ['HEALTH_MIN_SAMPLES', 10_001],
    ['SESSION_MAX_PER_MINUTE', 601],
    ['SESSION_MAX_PER_HOUR', 10_001],
    ['SESSION_MAX_PER_DAY', 100_001],
    ['PER_CHAT_MAX_PER_MINUTE', 61],
    ['COLD_SENDS_PER_DAY', 1001],
    ['LOOKUPS_PER_DAY', 10_001],
    ['UNREACHABLE_STREAK', 101],
    ['DUPLICATE_RECIPIENTS_THRESHOLD', 10_001],
    ['DUPLICATE_WINDOW_MINUTES', 1441]
  ])('refuses %s above its ceiling of the send policy', (key, value) => {
    expect(() => parseEnv({ ...valid, [key]: String(value) })).toThrow(new RegExp(key))
    expect(parseEnv({ ...valid, [key]: String(value - 1) })).toHaveProperty(key, value - 1)
  })
})
