import { z } from 'zod'

import { isValidAllowlistEntry } from '../common/lib/ssrf.js'

import { SEND_POLICY_LIMITS } from './send-policy-limits.js'

// Environment variables arrive as strings: numbers are coerced, and booleans are spelled
// exactly "true" or "false" (z.coerce.boolean would read the string "false" as true)
const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform(value => value === 'true')

const optionalFlag = () =>
  z
    .enum(['true', 'false'])
    .transform(value => value === 'true')
    .optional()

const count = (fallback: number, { min = 0, max }: { min?: number; max?: number } = {}) => {
  const base = z.coerce.number().int().min(min)
  return (max === undefined ? base : base.max(max)).default(fallback)
}

const fraction = (fallback: number) => z.coerce.number().min(0).max(1).default(fallback)

// Chromium takes no credentials for a SOCKS proxy, and the adapter decodes them for the other two
const PROXY_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'socks4:', 'socks5:'])

function isUsableProxy(value: string): boolean {
  // The field's own check reports a value that is not a URL
  if (!URL.canParse(value)) return true
  const url = new URL(value)
  if (!PROXY_PROTOCOLS.has(url.protocol)) return false
  const hasCredentials = url.username !== '' || url.password !== ''
  if (!hasCredentials) return true
  if (url.protocol.startsWith('socks')) return false
  try {
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return true
  } catch {
    return false
  }
}

const text = () => z.string().trim().min(1)

const list = () =>
  z
    .string()
    .optional()
    .transform(value =>
      (value ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0)
    )

// The repository is public: the secrets of .env.example are known to everyone
const PLACEHOLDER_PREFIX = 'replace-this-'

function coversEveryAddress(entry: string): boolean {
  return /\/0+$/.test(entry)
}

export const envSchema = z
  .object({
    // Core
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('production')
      .describe(
        'Runtime mode. Unset or empty means production, so a deployment that forgets it gets the strict checks instead of the development ones; set development for a local run'
      ),
    HOST: z.string().min(1).default('0.0.0.0').describe('Interface the HTTP server binds to'),
    PORT: count(3000, { min: 1, max: 65535 }).describe('Port the HTTP server listens on'),
    HTTP_REQUEST_TIMEOUT_MS: count(120000, { min: 1 }).describe(
      'Milliseconds a client has to send a whole request (headers and body); a request that is not complete by then is closed. A body of the largest size (about 40 MiB with media) needs a client that uploads faster than 350 KB/s at the default'
    ),
    HTTP_HEADERS_TIMEOUT_MS: count(30000, { min: 1 }).describe(
      'Milliseconds a client has to send the headers of a request; must not be longer than HTTP_REQUEST_TIMEOUT_MS'
    ),
    HTTP_CONNECTION_TIMEOUT_MS: count(0).describe(
      'Milliseconds of silence after which a connection is closed (0 = never). Leave it at 0 or above the longest wait for an answer (about 185 s): a connection that waits for a slow WhatsApp call is silent'
    ),
    PUBLIC_BASE_URL: z
      .url({ protocol: /^https?$/ })
      .describe('Public URL of the gateway, used to build absolute links'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info')
      .describe('Minimum level written by the logger'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).describe('PostgreSQL connection string'),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).describe('Redis connection string'),
    REDIS_CONNECT_TIMEOUT_MS: count(15000, { min: 1 }).describe(
      'Milliseconds the gateway waits for Redis at start before it exits with an error; once it runs, a lost connection is retried without a limit'
    ),
    ADMIN_API_KEY: z
      .string()
      .trim()
      .min(32)
      .describe('Admin API key, 32 characters or more (stored only as a hash)'),
    METRICS_TOKEN: text()
      .min(32)
      .optional()
      .describe(
        'Bearer token, 32 characters or more, that grants access to GET /metrics; when unset, only an admin key can read it'
      ),
    API_KEY_ROTATION_GRACE_MINUTES: count(10).describe(
      'Minutes the previous API key keeps working after a rotation'
    ),
    API_KEY_MAX_TTL_DAYS: count(0).describe(
      'Longest lifetime in days an API key may be given; 0 means no cap'
    ),
    TRUST_PROXY_HOPS: count(0).describe(
      'Reverse proxies whose X-Forwarded-For is trusted when resolving the client IP; behind a proxy it must be set, or every client shares the proxy address and its rate limit'
    ),
    BULL_BOARD_ENABLED: flag(false).describe('Serve the BullMQ dashboard to admin keys'),
    CORS_ORIGINS: list().describe(
      'Comma-separated origins allowed by CORS and Socket.IO; a * is refused in production'
    ),
    RATE_LIMIT_MAX: count(300, { min: 1 }).describe(
      'Requests per minute allowed per API key and, separately, per client address'
    ),
    ENABLE_GROUP_WRITES: flag(false).describe(
      "Allow the writes to groups that can get an account blocked: create a group, add, remove, promote and demote participants, revoke an invite link, and join or accept an invite. Off by default: automating group creation or changes goes against WhatsApp's terms, two test accounts were blocked after them, and an add was followed by a logout. Reads, the events of groups, changing the subject, the description and the settings of a group, and leaving one stay on"
    ),
    ENABLE_DOCS: optionalFlag().describe(
      'Serve Swagger UI and the OpenAPI JSON; when unset, true except in production, where true is refused'
    ),

    // WhatsApp
    WWEBJS_DATA_PATH: text()
      .default('./.wwebjs_auth')
      .describe(
        'Folder where whatsapp-web.js keeps the authenticated sessions. It is created if missing and tested for writing at boot: the gateway does not start when it cannot be used, and /ready goes 503 if it stops being writable'
      ),
    PUPPETEER_EXECUTABLE_PATH: text()
      .optional()
      .describe(
        'Chromium or Chrome binary. Set it: the install does not download one (puppeteer build scripts are off), so a session cannot start without it'
      ),
    WWEB_VERSION: text()
      .optional()
      .describe('Pins the WhatsApp Web version; when unset, the live latest build'),
    WWEB_VERSION_CACHE_TYPE: z
      .enum(['local', 'remote', 'none'])
      .default('local')
      .describe('Where the pinned WhatsApp Web HTML snapshot is read from'),
    WWEB_CACHE_PATH: text()
      .default('./.wwebjs_cache')
      .describe('Folder holding the local WhatsApp Web HTML snapshots'),
    WWEB_VERSION_REMOTE_PATH: text()
      .optional()
      .describe(
        'https URL template of the remote snapshots with a {version} placeholder; required when WWEB_VERSION_CACHE_TYPE is remote. The page it serves runs inside the logged-in browser: trust the host'
      ),
    WWEB_VERIFIED_BUILD: text()
      .regex(/^2\.3000\.\d{1,20}$/, 'Not a WhatsApp Web build such as 2.3000.1054292354')
      .optional()
      .describe(
        'The WhatsApp Web build last checked with a real account (for example 2.3000.1054292354). A session that runs another build logs a warning when it becomes ready; nothing else changes. Unset means no comparison'
      ),
    WWEB_VERSION_STRICT: flag(true).describe(
      'Fail the session start when the pinned WhatsApp Web version cannot be loaded, instead of running the live latest build'
    ),
    QR_MAX_RETRIES: count(6).describe(
      'QR codes refreshed before a session gives up pairing (wwebjs shows this number plus one); 0 never gives up and keeps the browser running'
    ),
    TAKEOVER_ON_CONFLICT: flag(false).describe(
      'Take the session back when WhatsApp Web is opened elsewhere'
    ),
    DEVICE_NAME: text().optional().describe('Device name shown in the linked devices list'),
    BROWSER_NAME: text().optional().describe('Browser name shown in the linked devices list'),
    PROXY_URL: z
      .url()
      .optional()
      .describe(
        'Proxy the Chromium traffic goes through (http, https, socks4 or socks5); credentials in the URL work for http and https only; when unset, a direct connection'
      ),
    WA_CALL_TIMEOUT_MS: count(60000, { min: 1 }).describe(
      'Milliseconds a call to WhatsApp Web may take before it is abandoned'
    ),
    FFMPEG_PATH: text()
      .optional()
      .describe('ffmpeg binary used to convert media; when unset, the one on the PATH'),

    // Sessions
    MAX_SESSIONS: count(10, { min: 1 }).describe('Sessions the gateway accepts to create'),
    SESSION_START_STAGGER_MS: count(5000).describe(
      'Milliseconds between the starts of sessions at boot'
    ),
    SESSION_START_TIMEOUT_MS: count(180000, { min: 1 }).describe(
      'Milliseconds a session may take to become ready'
    ),
    SESSION_RECONNECT_MAX_ATTEMPTS: count(0).describe(
      'Reconnection attempts after a disconnect; 0 means unlimited'
    ),
    SESSION_INITIALIZE_MAX_ATTEMPTS: count(5, { min: 3 }).describe(
      'Consecutive failed browser starts of a session before it is marked failed (at least 3: it also decides when a login that never connects is moved to quarantine)'
    ),
    SESSION_AUTH_QUARANTINE_TTL_DAYS: count(7, { min: 1 }).describe(
      'Days a saved login that the gateway moved aside (WWEBJS_DATA_PATH/.quarantine) is kept before it is deleted for good'
    ),
    WATCHDOG_INTERVAL_MS: count(30000, { min: 1 }).describe(
      'Milliseconds between health checks of each session'
    ),
    WATCHDOG_MAX_FAILURES: count(3, { min: 1 }).describe(
      'Consecutive failed health checks before a session is restarted'
    ),
    MEMORY_RESTART_THRESHOLD_MB: count(0).describe(
      'Resident memory in MB of the gateway process plus the browsers of its sessions, above which the largest idle session is restarted; 0 disables the check'
    ),

    // Ordering and reconciliation
    INBOUND_ORDERING_ENABLED: flag(true).describe('Hold and sort inbound messages per chat'),
    INBOUND_LATE_THRESHOLD_S: count(3).describe(
      'Seconds of difference in sentAt after which a message counts as late'
    ),
    INBOUND_ORDER_WINDOW_MS: count(1500).describe(
      'Milliseconds the order buffer waits for earlier messages of a chat'
    ),
    INBOUND_ORDER_MAX_HOLD_MS: count(5000).describe(
      'Longest time in milliseconds a message is held, whatever keeps arriving'
    ),
    INBOUND_ORDER_MAX_MESSAGES: count(200, { min: 1 }).describe(
      'Messages a chat may hold in the order buffer before it flushes'
    ),
    MESSAGE_BATCH_ENABLED: flag(true).describe('Publish the synthesized message_batch event'),
    RECONCILE_ON_READY: flag(true).describe(
      'Fetch the recent messages of the busiest chats when a session becomes ready'
    ),
    RECONCILE_MAX_CHATS: count(50).describe(
      'Chats the reconciler visits per session start (0 turns the reconciliation off)'
    ),
    RECONCILE_FETCH_LIMIT: count(50, { min: 1 }).describe(
      'Messages the reconciler fetches per chat'
    ),
    RECONCILE_LOOKBACK_HOURS: count(48).describe(
      'Hours into the past the reconciler looks for missed messages (0 turns the reconciliation off)'
    ),

    // Message data
    INCLUDE_RAW: flag(true).describe('Attach the sanitized raw WhatsApp data to messages'),
    RAW_MAX_FIELD_BYTES: count(8192, { min: 1 }).describe(
      'Bytes a single field of the raw data may take before it is truncated'
    ),

    // Sending
    SEND_MIN_INTERVAL_MS: count(1000).describe(
      'Minimum milliseconds between two sends of the same session'
    ),
    SEND_JITTER_MS: count(400).describe('Random milliseconds added to the send interval'),
    SEND_SYNC_TIMEOUT_MS: count(60000, { min: 1 }).describe(
      'Milliseconds a synchronous send request waits for the outcome'
    ),
    SEND_MAX_WAIT_MS: count(300000, { min: 1 }).describe(
      'Milliseconds an accepted send waits for a session that is not ready, counted from when it first finds the session not ready (not from when it was queued), before it fails'
    ),
    SEND_NOT_READY_RETRY_MS: count(5000, { min: 1 }).describe(
      'Milliseconds before a send is retried while its session is not ready'
    ),
    SEND_BREAKER_THRESHOLD: count(5, { min: 1 }).describe(
      'Consecutive send failures that open the circuit breaker of a session'
    ),
    SEND_BREAKER_COOLDOWN_MS: count(60000, { min: 1 }).describe(
      'Milliseconds an open circuit breaker stays open'
    ),
    MAX_MEDIA_BYTES: count(33554432, { min: 1 }).describe('Largest media file in bytes'),
    MEDIA_FETCH_CONCURRENCY: count(4, { min: 1 }).describe(
      'Media URLs downloaded at the same time (all the sessions together; when they are all busy the next turn goes to the session that has waited longest since its last one); each one can hold up to MAX_MEDIA_BYTES, about three times over while it is converted'
    ),
    MEDIA_FETCH_TIMEOUT_MS: count(30000, { min: 1 }).describe(
      'Milliseconds the download of a media URL of a send may take'
    ),
    SEND_QUEUE_MAX_PER_SESSION: count(500, { min: 1 }).describe(
      'Sends a session may have waiting or running in its queue; the next one is refused with 429 SEND_QUEUE_FULL. Redis keeps every job, media included, so the memory this allows is this number times the size of the sends'
    ),
    SEND_QUEUE_MAX_TOTAL: count(2000, { min: 1 }).describe(
      'Sends all the sessions together may have waiting or running; the next one is refused with 429 SEND_QUEUE_FULL'
    ),
    SEND_ENQUEUE_TIMEOUT_MS: count(5000, { min: 1 }).describe(
      'Milliseconds the gateway waits for Redis to accept a send before it answers 503 QUEUE_UNAVAILABLE, or a webhook delivery before it is marked failed'
    ),

    // Send policy (every value can be overridden per session)
    CONVERSATION_WINDOW_HOURS: count(24, { min: 1 }).describe(
      'Hours after the last inbound message during which a chat counts as a conversation'
    ),
    ALLOW_COLD_SENDS: flag(false).describe('Allow sending to chats without a conversation'),
    COLD_SENDS_PER_DAY: count(20, { max: SEND_POLICY_LIMITS.coldSendsPerDay }).describe(
      'Cold sends allowed per session per day'
    ),
    COLD_SEND_MIN_GAP_MS: count(60000).describe('Minimum milliseconds between two cold sends'),
    LOOKUPS_PER_DAY: count(100, { max: SEND_POLICY_LIMITS.lookupsPerDay }).describe(
      'Number lookups allowed per session per day'
    ),
    PER_CHAT_MIN_INTERVAL_MS: count(1500).describe(
      'Minimum milliseconds between two sends to the same chat'
    ),
    PER_CHAT_MAX_PER_MINUTE: count(10, {
      min: 1,
      max: SEND_POLICY_LIMITS.perChatMaxPerMinute
    }).describe('Sends per minute to the same chat'),
    SESSION_MAX_PER_MINUTE: count(20, {
      min: 1,
      max: SEND_POLICY_LIMITS.sessionMaxPerMinute
    }).describe('Sends per minute of a session'),
    SESSION_MAX_PER_HOUR: count(300, {
      min: 1,
      max: SEND_POLICY_LIMITS.sessionMaxPerHour
    }).describe('Sends per hour of a session'),
    SESSION_MAX_PER_DAY: count(1500, { min: 1, max: SEND_POLICY_LIMITS.sessionMaxPerDay }).describe(
      'Sends per day of a session'
    ),
    DUPLICATE_RECIPIENTS_THRESHOLD: count(5, {
      min: 1,
      max: SEND_POLICY_LIMITS.duplicateRecipients
    }).describe('Recipients of the same text inside the window that count as a mass send'),
    DUPLICATE_WINDOW_MINUTES: count(10, {
      min: 1,
      max: SEND_POLICY_LIMITS.duplicateWindowMinutes
    }).describe('Minutes in which identical texts are compared'),
    WARMUP_DAYS: count(14).describe('Days over which a new session ramps up to its full limits'),
    WARMUP_START_FRACTION: fraction(0.1).describe(
      'Fraction of the limits a session starts with on its first day'
    ),
    UNREACHABLE_STREAK: count(5, { min: 1, max: SEND_POLICY_LIMITS.unreachableStreak }).describe(
      'Consecutive unanswered sends that mark a recipient as unreachable'
    ),
    UNREACHABLE_MIN_AGE_HOURS: count(72).describe(
      'Hours a send must remain unanswered before it counts toward the unreachable streak'
    ),
    SEND_POLICY_MAX_WAIT_MS: count(1800000, { min: 1 }).describe(
      'Longest milliseconds the send policy may delay a message'
    ),
    HEALTH_WINDOW: count(50, { min: 1, max: SEND_POLICY_LIMITS.healthWindow }).describe(
      'Recent sends the session health score uses'
    ),
    HEALTH_MIN_SAMPLES: count(10, { min: 1, max: SEND_POLICY_LIMITS.healthWindow }).describe(
      'Results the health score needs before it can pause a session (at most HEALTH_WINDOW counts)'
    ),
    HEALTH_MAX_BAD_RATIO: fraction(0.2).describe(
      'Ratio of bad outcomes in the window that pauses the session'
    ),
    HEALTH_COOLDOWN_MIN: count(30).describe('Minutes a session stays paused after a bad window'),
    HUMANIZE_MIN_REPLY_DELAY_MS: count(1500).describe(
      'Minimum milliseconds between an inbound message and the reply to it'
    ),

    // Events and webhooks
    EVENT_REPLAY_WINDOW_SECONDS: count(300).describe(
      'Seconds of past events a reconnecting socket may replay'
    ),
    WEBHOOKS_MAX_PER_SESSION: count(20, { min: 1 }).describe(
      'Webhooks a session can have, and as many for those of every session; creating one past it is refused. Also the most active inbound hooks a session can have'
    ),
    INBOUND_HOOK_MAX_PER_MINUTE: count(60, { min: 1 }).describe(
      'Messages one inbound hook (POST /v1/hooks/inbound/:token) accepts per minute; one more is refused with 429 RATE_LIMITED. Stricter than RATE_LIMIT_MAX, which also applies to the address'
    ),
    WEBHOOK_TEST_MAX_PER_MINUTE: count(6, { min: 1 }).describe(
      'Test pings (POST /v1/webhooks/:id/test) a webhook accepts per minute; one more is refused with 429 RATE_LIMITED. Each one is a signed request to the URL of the webhook'
    ),
    WEBHOOK_TIMEOUT_MS: count(10000, { min: 1 }).describe(
      'Milliseconds a webhook endpoint has to answer'
    ),
    WEBHOOK_MAX_ATTEMPTS: count(10, { min: 1 }).describe('Delivery attempts per webhook event'),
    WEBHOOK_BACKOFF_MS: count(5000, { min: 1 }).describe(
      'Milliseconds before the first webhook retry; later retries back off exponentially'
    ),
    WEBHOOK_WORKER_CONCURRENCY: count(10, { min: 1 }).describe('Webhook deliveries in parallel'),
    WEBHOOK_INLINE_MEDIA_MAX_BYTES: count(5242880).describe(
      'Largest media in bytes a webhook carries inline; larger media goes by URL'
    ),
    WEBHOOK_PRIVATE_HOST_ALLOWLIST: list()
      .refine(items => items.every(isValidAllowlistEntry), {
        message: 'Every entry must be a hostname, an IP address or a CIDR such as 10.0.0.0/8'
      })
      .describe(
        'Comma-separated hosts exempt from the private-address check of webhook URLs; a range that covers every address (0.0.0.0/0, ::/0) is refused in production'
      ),
    ALLOW_PRIVATE_WEBHOOK_TARGETS: flag(false).describe(
      'Allow webhook URLs that resolve to private addresses; development only, refused in production'
    ),
    MEDIA_PRIVATE_HOST_ALLOWLIST: list()
      .refine(items => items.every(isValidAllowlistEntry), {
        message: 'Every entry must be a hostname, an IP address or a CIDR such as 10.0.0.0/8'
      })
      .describe(
        'Comma-separated hosts a send may download media from although they are private. Empty by default and apart from WEBHOOK_PRIVATE_HOST_ALLOWLIST: the media URL comes from the caller of a send, and the file is sent on to a WhatsApp chat, so any host listed here can be read by every key that may send. A range that covers every address (/0) is refused in production'
      ),
    CALL_CACHE_SIZE: count(50, { min: 1 }).describe('Recent calls kept in memory to reject them'),

    // Retention
    DELIVERY_RETENTION_DAYS: count(14, { min: 1 }).describe(
      'Days webhook deliveries are kept before they are deleted'
    ),
    MESSAGE_RETENTION_DAYS: count(30, { min: 1 }).describe(
      'Days messages are kept before they are deleted'
    ),
    STORE_MESSAGE_BODIES: flag(true).describe('Store the text of messages, not only their metadata')
  })
  .refine(env => env.WWEB_VERSION_CACHE_TYPE !== 'remote' || env.WWEB_VERSION_REMOTE_PATH, {
    path: ['WWEB_VERSION_REMOTE_PATH'],
    error: 'is required when WWEB_VERSION_CACHE_TYPE is remote'
  })
  .refine(env => env.WWEB_VERSION_CACHE_TYPE !== 'remote' || env.WWEB_VERSION, {
    path: ['WWEB_VERSION'],
    error: 'is required when WWEB_VERSION_CACHE_TYPE is remote'
  })
  .refine(
    env => !env.WWEB_VERSION_REMOTE_PATH || env.WWEB_VERSION_REMOTE_PATH.startsWith('https://'),
    {
      path: ['WWEB_VERSION_REMOTE_PATH'],
      error: 'must be an https URL'
    }
  )
  .refine(env => !env.PROXY_URL || isUsableProxy(env.PROXY_URL), {
    path: ['PROXY_URL'],
    error:
      'must use http, https, socks4 or socks5, with credentials only for http and https, percent-encoded'
  })
  .refine(
    env => !env.WWEB_VERSION_REMOTE_PATH || env.WWEB_VERSION_REMOTE_PATH.includes('{version}'),
    {
      path: ['WWEB_VERSION_REMOTE_PATH'],
      error: 'must contain the {version} placeholder'
    }
  )
  .refine(
    env =>
      env.NODE_ENV !== 'production' ||
      !env.ADMIN_API_KEY.toLowerCase().startsWith(PLACEHOLDER_PREFIX),
    {
      path: ['ADMIN_API_KEY'],
      error: 'is still the placeholder of .env.example'
    }
  )
  .refine(
    env =>
      env.NODE_ENV !== 'production' ||
      !env.METRICS_TOKEN?.toLowerCase().startsWith(PLACEHOLDER_PREFIX),
    {
      path: ['METRICS_TOKEN'],
      error: 'is still the placeholder of .env.example'
    }
  )
  // The switch lifts the SSRF guard of every webhook delivery and media fetch (TDD §6.9). Production
  // reaches its private targets through WEBHOOK_PRIVATE_HOST_ALLOWLIST, which names each one.
  .refine(env => env.NODE_ENV !== 'production' || !env.ALLOW_PRIVATE_WEBHOOK_TARGETS, {
    path: ['ALLOW_PRIVATE_WEBHOOK_TARGETS'],
    error:
      'must not be true in production: list the private targets in WEBHOOK_PRIVATE_HOST_ALLOWLIST'
  })
  // The docs list every route and its schemas, and CLAUDE.md keeps them off in production
  .refine(env => env.NODE_ENV !== 'production' || env.ENABLE_DOCS !== true, {
    path: ['ENABLE_DOCS'],
    error: 'must not be true in production: the API documentation stays private'
  })
  .refine(env => env.NODE_ENV !== 'production' || !env.CORS_ORIGINS.includes('*'), {
    path: ['CORS_ORIGINS'],
    error: 'must not contain * in production: list the origins that may call the gateway'
  })
  // A /0 range would turn the allowlist into "any private or internal address", which is what the
  // SSRF guard exists to stop
  .refine(
    env =>
      env.NODE_ENV !== 'production' || !env.WEBHOOK_PRIVATE_HOST_ALLOWLIST.some(coversEveryAddress),
    {
      path: ['WEBHOOK_PRIVATE_HOST_ALLOWLIST'],
      error: 'must not contain a range that covers every address (a /0 prefix) in production'
    }
  )
  .refine(
    env =>
      env.NODE_ENV !== 'production' || !env.MEDIA_PRIVATE_HOST_ALLOWLIST.some(coversEveryAddress),
    {
      path: ['MEDIA_PRIVATE_HOST_ALLOWLIST'],
      error: 'must not contain a range that covers every address (a /0 prefix) in production'
    }
  )
  .refine(env => env.SEND_QUEUE_MAX_TOTAL >= env.SEND_QUEUE_MAX_PER_SESSION, {
    path: ['SEND_QUEUE_MAX_TOTAL'],
    error: 'must not be smaller than SEND_QUEUE_MAX_PER_SESSION'
  })
  .refine(env => env.HTTP_HEADERS_TIMEOUT_MS <= env.HTTP_REQUEST_TIMEOUT_MS, {
    path: ['HTTP_HEADERS_TIMEOUT_MS'],
    error: 'must not be longer than HTTP_REQUEST_TIMEOUT_MS'
  })
  .refine(env => env.INBOUND_ORDER_MAX_HOLD_MS >= env.INBOUND_ORDER_WINDOW_MS, {
    path: ['INBOUND_ORDER_MAX_HOLD_MS'],
    error: 'must not be shorter than INBOUND_ORDER_WINDOW_MS'
  })

type ParsedEnv = z.output<typeof envSchema>

// The environment as the rest of the code reads it: ENABLE_DOCS is always resolved
export type AppConfig = Omit<ParsedEnv, 'ENABLE_DOCS'> & { ENABLE_DOCS: boolean }

// A variable set to an empty value (`FOO=`) counts as unset: z.coerce.number() would read it as 0.
// So an empty NODE_ENV is unset, and unset means production.
export function parseEnv(raw: Record<string, unknown>): AppConfig {
  const present = Object.entries(raw).filter(
    ([, value]) => typeof value !== 'string' || value.trim() !== ''
  )
  const result = envSchema.safeParse(Object.fromEntries(present))
  if (!result.success) {
    const lines = result.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid environment variables:\n${lines.join('\n')}`)
  }
  const env = result.data
  return { ...env, ENABLE_DOCS: env.ENABLE_DOCS ?? env.NODE_ENV !== 'production' }
}
