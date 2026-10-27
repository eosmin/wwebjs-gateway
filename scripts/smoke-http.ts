// Probes a running service the way a load balancer or an operator would. CI boots the built app and
// runs it; step 4.7 adds /ready, /metrics and the error contract.
// Usage: tsx scripts/smoke-http.ts <baseUrl>
import { argv, exit } from 'node:process'

const REQUEST_TIMEOUT_MS = 5_000
const WAIT_MS = 30_000
const RETRY_EVERY_MS = 1_000

const baseUrl = argv[2]
// `localhost:3000` parses as a URL whose scheme is "localhost:", so the protocol is checked too
if (baseUrl === undefined || !/^https?:\/\//.test(baseUrl) || !URL.canParse(baseUrl)) {
  console.error(`usage: tsx scripts/smoke-http.ts <baseUrl>  (got: ${baseUrl ?? 'nothing'})`)
  exit(1)
}

async function get(path: string): Promise<Response> {
  // A redirect is a failure: a probe must not be sent to a host it was not pointed at
  return fetch(new URL(path, baseUrl), {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
}

async function waitForHealth(): Promise<Response> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    try {
      const response = await get('/health')
      if (response.status === 200) return response
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

const health = await waitForHealth()

const problems: string[] = []
const body: unknown = await health.json().catch(() => undefined)
if (typeof body !== 'object' || body === null || !('status' in body) || body.status !== 'ok') {
  // Only the shape: a later step may put a version or a hostname in this body, and CI logs are public
  const shape =
    typeof body === 'object' && body !== null ? Object.keys(body).join(', ') : typeof body
  problems.push(`GET /health body is not { "status": "ok" } (it has: ${shape || 'no keys'})`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`${baseUrl}: ${problem}`)
  exit(1)
}
console.log(`${baseUrl}: the liveness probe is fine`)
