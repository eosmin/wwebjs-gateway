import { createHmac, timingSafeEqual } from 'node:crypto'
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// The reference receiver of docs/webhooks.md (TDD §6.9): what a consumer of the gateway has to do,
// written against the contract of the documentation and not against the code of the gateway. It
// does not import the signer of the gateway on purpose: the integration suite proves that a
// receiver built from the documentation accepts what the gateway sends.
//
// - It verifies the signature over the raw bytes, in constant time, and refuses a timestamp that is
//   too old or too new (a captured request cannot be replayed later).
// - It tolerates redelivery: a delivery it already handled (`X-Gateway-Delivery`) is acknowledged
//   again and not handled twice.
// - It buffers by `seq`, per session, and hands events over in order, because retries reach it in no
//   particular order.

export interface VerifyOptions {
  toleranceSeconds: number
  nowSeconds: number
}

export type SignatureResult = { ok: true } | { ok: false; reason: string }

export function verifySignature(
  secret: string,
  headers: IncomingHttpHeaders,
  rawBody: string,
  options: VerifyOptions
): SignatureResult {
  const timestampHeader = headers['x-gateway-timestamp']
  const signatureHeader = headers['x-gateway-signature']
  if (typeof timestampHeader !== 'string' || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing header' }
  }
  const timestamp = Number(timestampHeader)
  if (!Number.isInteger(timestamp)) return { ok: false, reason: 'timestamp is not a number' }
  if (Math.abs(options.nowSeconds - timestamp) > options.toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside the tolerance' }
  }
  if (!signatureHeader.startsWith('sha256=')) return { ok: false, reason: 'unknown scheme' }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  const given = Buffer.from(signatureHeader.slice('sha256='.length), 'hex')
  // timingSafeEqual throws on different lengths, which already tells nothing about the content
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature does not match' }
  }
  return { ok: true }
}

export interface ReceivedEvent {
  deliveryId: string
  event: string
  sessionId: string
  seq: number
  data: unknown
  // The envelope as the gateway sent it
  envelope: Record<string, unknown>
}

// Hands events over in `seq` order per session and never twice. `ping` (seq 0) is not part of the
// sequence of a session: it goes through at once.
//
// Waiting for the event before is only possible when the webhook receives every event (`*`): with a
// filter the `seq` of the events it does not want are missing, and a receiver that waited for them
// would wait for ever. `ordered: false` is for those webhooks: it drops repeats and nothing else.
// `firstSeq: 'first-seen'` starts the sequence at the first event that arrives, for a receiver
// that is created while the session is already running.
export class OrderedConsumer {
  private readonly seen = new Set<string>()
  private readonly next = new Map<string, number>()
  private readonly held = new Map<string, Map<number, ReceivedEvent>>()

  constructor(
    private readonly firstSeq: number | 'first-seen' = 1,
    private readonly ordered = true
  ) {}

  // True when it is a delivery handled before (the answer is still a success)
  isRepeat(deliveryId: string): boolean {
    return this.seen.has(deliveryId)
  }

  // The events that can be handed over now, in order
  accept(received: ReceivedEvent): ReceivedEvent[] {
    if (this.seen.has(received.deliveryId)) return []
    this.seen.add(received.deliveryId)
    if (received.seq === 0 || !this.ordered) return [received]
    const { sessionId, seq } = received
    const expected =
      this.next.get(sessionId) ?? (this.firstSeq === 'first-seen' ? seq : this.firstSeq)
    // Behind the sequence: a seq already handed over under another delivery id cannot come back
    if (seq < expected) return []
    const held = this.held.get(sessionId) ?? new Map<number, ReceivedEvent>()
    held.set(seq, received)
    this.held.set(sessionId, held)
    const released: ReceivedEvent[] = []
    let cursor = expected
    for (let event = held.get(cursor); event !== undefined; event = held.get(cursor)) {
      released.push(event)
      held.delete(cursor)
      cursor += 1
    }
    this.next.set(sessionId, cursor)
    return released
  }

  // What waits for an earlier event, by session
  pending(sessionId: string): number[] {
    return [...(this.held.get(sessionId)?.keys() ?? [])].sort((a, b) => a - b)
  }
}

export interface RejectedRequest {
  reason: string
  headers: IncomingHttpHeaders
}

export interface WebhookReceiverOptions {
  // The secret can be rotated while the receiver runs
  secret: string
  toleranceSeconds?: number
  firstSeq?: number | 'first-seen'
  // False for a webhook with a filter on its events (see OrderedConsumer)
  ordered?: boolean
  host?: string
  now?: () => number
}

// An HTTP server that behaves as the documentation says a receiver should. `failNext` makes the
// following requests answer an error after they were verified, to test the retries of the gateway.
export class WebhookReceiver {
  // Everything that reached the server, as it came
  readonly requests: { headers: IncomingHttpHeaders; body: string }[] = []
  // What was handed over, in order
  readonly handled: ReceivedEvent[] = []
  readonly rejected: RejectedRequest[] = []
  secret: string
  private readonly consumer: OrderedConsumer
  private readonly toleranceSeconds: number
  private readonly host: string
  private readonly now: () => number
  private server: Server | undefined
  private failures: number[] = []
  address = ''

  constructor(options: WebhookReceiverOptions) {
    this.secret = options.secret
    this.consumer = new OrderedConsumer(options.firstSeq ?? 1, options.ordered ?? true)
    this.toleranceSeconds = options.toleranceSeconds ?? 300
    this.host = options.host ?? '127.0.0.1'
    this.now = options.now ?? (() => Date.now() / 1000)
  }

  // The next requests (after verification) answer these statuses, one each
  failNext(...statuses: number[]): void {
    this.failures.push(...statuses)
  }

  pending(sessionId: string): number[] {
    return this.consumer.pending(sessionId)
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const status = this.receive(request.headers, Buffer.concat(chunks).toString('utf8'))
        response.statusCode = status
        response.end()
      })
    })
    this.server = server
    await new Promise<void>(resolve => server.listen(0, this.host, resolve))
    this.address = `http://${this.host}:${(server.address() as AddressInfo).port}`
    return this.address
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  // The status the receiver answers for one request
  private receive(headers: IncomingHttpHeaders, body: string): number {
    this.requests.push({ headers, body })
    const verified = verifySignature(this.secret, headers, body, {
      toleranceSeconds: this.toleranceSeconds,
      nowSeconds: this.now()
    })
    if (!verified.ok) {
      this.rejected.push({ reason: verified.reason, headers })
      return 401
    }
    const failure = this.failures.shift()
    if (failure !== undefined) return failure
    const received = this.parse(headers, body)
    if (received === undefined) return 400
    // A repeat is acknowledged again: answering an error would only make the gateway send it once more
    this.handled.push(...this.consumer.accept(received))
    return 200
  }

  private parse(headers: IncomingHttpHeaders, body: string): ReceivedEvent | undefined {
    const deliveryId = headers['x-gateway-delivery']
    if (typeof deliveryId !== 'string') return undefined
    let envelope: unknown
    try {
      envelope = JSON.parse(body)
    } catch {
      return undefined
    }
    if (typeof envelope !== 'object' || envelope === null) return undefined
    const { event, sessionId, seq, data } = envelope as Record<string, unknown>
    if (typeof event !== 'string' || typeof sessionId !== 'string' || typeof seq !== 'number') {
      return undefined
    }
    return {
      deliveryId,
      event,
      sessionId,
      seq,
      data,
      envelope: envelope as Record<string, unknown>
    }
  }
}
