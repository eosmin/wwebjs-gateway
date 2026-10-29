// Probes a running service the way a load balancer or an operator would: liveness, readiness, the
// metrics (closed without the token), the error contract, and whether the API docs are served.
// CI boots the built app and the image and runs this against each.
// Usage: METRICS_TOKEN=<token> tsx scripts/smoke-http.ts <baseUrl> --docs=on|off
import { argv, env, exit } from 'node:process'

const REQUEST_TIMEOUT_MS = 5_000
const WAIT_MS = 30_000
const RETRY_EVERY_MS = 1_000

const usage = 'usage: METRICS_TOKEN=<token> tsx scripts/smoke-http.ts <baseUrl> --docs=on|off'
const baseUrl = argv[2]
const docs = argv[3]
// `localhost:3000` parses as a URL whose scheme is "localhost:", so the protocol is checked too
if (baseUrl === undefined || !/^https?:\/\//.test(baseUrl) || !URL.canParse(baseUrl)) {
  console.error(`${usage}  (got: ${baseUrl ?? 'nothing'})`)
  exit(1)
}
if (docs !== '--docs=on' && docs !== '--docs=off') {
  console.error(`${usage}  (got: ${docs ?? 'nothing'})`)
  exit(1)
}
const metricsToken = env['METRICS_TOKEN']
if (metricsToken === undefined || metricsToken === '') {
  console.error(`${usage}  (METRICS_TOKEN is not set)`)
  exit(1)
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  // A redirect is a failure: a probe must not be sent to a host it was not pointed at
  return fetch(new URL(path, baseUrl), {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    try {
      if ((await get('/health')).status === 200) return
    } catch {
      // not listening yet: try again until the deadline
    }
    if (Date.now() >= deadline) {
      console.error(`${baseUrl}: GET /health did not answer 200 within ${WAIT_MS / 1000} s`)
      exit(1)
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_EVERY_MS))
  }
}

// Only the shape of a body is ever printed: a later step may put a version or a hostname in it, and CI logs are public
function shapeOf(body: unknown): string {
  return typeof body === 'object' && body !== null
    ? Object.keys(body).join(', ') || 'no keys'
    : typeof body
}

const problems: string[] = []

async function check(label: string, probe: () => Promise<string | undefined>): Promise<void> {
  try {
    const problem = await probe()
    if (problem !== undefined) problems.push(`${label}: ${problem}`)
  } catch (error) {
    problems.push(`${label}: no answer (${error instanceof Error ? error.name : typeof error})`)
  }
}

function statusProblem(response: Response, expected: number): string | undefined {
  return response.status === expected
    ? undefined
    : `answered ${response.status}, expected ${expected}`
}

await waitForHealth()

await check('GET /health', async () => {
  const response = await get('/health')
  const body: unknown = await response.json().catch(() => undefined)
  return (
    statusProblem(response, 200) ??
    (typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok'
      ? undefined
      : `body is not { "status": "ok" } (it has: ${shapeOf(body)})`)
  )
})

await check('GET /ready', async () => {
  const response = await get('/ready')
  const body: unknown = await response.json().catch(() => undefined)
  return (
    statusProblem(response, 200) ??
    (typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok'
      ? undefined
      : `body is not { "status": "ok" } (it has: ${shapeOf(body)})`)
  )
})

await check('GET /metrics with the token', async () => {
  const response = await get('/metrics', { authorization: `Bearer ${metricsToken}` })
  const text = await response.text()
  return (
    statusProblem(response, 200) ??
    (text.includes('# TYPE gw_sessions ') ? undefined : 'the exposition has no gw_sessions series')
  )
})

await check('GET /metrics without credentials', async () =>
  statusProblem(await get('/metrics'), 401)
)

await check('the error contract', async () => {
  const response = await get('/v1/unknown')
  const body: unknown = await response.json().catch(() => undefined)
  const error =
    typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined
  const ok =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'NOT_FOUND' &&
    'requestId' in error &&
    typeof error.requestId === 'string' &&
    error.requestId === response.headers.get('x-request-id')
  return (
    statusProblem(response, 404) ??
    (ok ? undefined : `GET /v1/unknown body is not the error contract (it has: ${shapeOf(body)})`)
  )
})

await check('GET /v1/system/info without a key', async () => {
  const response = await get('/v1/system/info')
  const body: unknown = await response.json().catch(() => undefined)
  const code =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body.error as { code?: unknown }).code
      : undefined
  return statusProblem(response, 401) ?? (code === 'UNAUTHORIZED' ? undefined : 'not UNAUTHORIZED')
})

// Nothing else tests that main.ts calls setupDocs, or that it leaves it out when the docs are off
await check('GET /docs/json', async () =>
  statusProblem(await get('/docs/json'), docs === '--docs=on' ? 200 : 404)
)

if (problems.length > 0) {
  for (const problem of problems) console.error(`${baseUrl}: ${problem}`)
  exit(1)
}
console.log(`${baseUrl}: probes, metrics and the error contract are fine (docs ${docs.slice(7)})`)
