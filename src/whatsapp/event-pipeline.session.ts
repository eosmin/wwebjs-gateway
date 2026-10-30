import { Logger } from '@nestjs/common'

import { withTimeout } from '../common/lib/timeout.js'
import type { StoredMessage } from '../database/models.js'
import type { NewStoredMessage } from '../database/repositories/messages.repository.js'
import type { Metrics } from '../infra/metrics/metrics.service.js'
import type { MessageDto } from '../types/dto.js'
import type { WaEventName } from '../types/events.js'

import { dedupeSuffix, followedMessageId } from './event-pipeline.keys.js'
import type { Emit, EventSequencer } from './event-pipeline.sequencer.js'
import { toMessageDto, toNewStoredMessage } from './event-pipeline.storage.js'
import {
  InboundOrderBuffer,
  buildBatch,
  type BatchReason,
  type MessageBatch,
  type OrderBufferOptions,
  type ReleasedBatch
} from './inbound-order-buffer.js'
import type { ClientEvent, WhatsAppClientPort } from './whatsapp-client.port.js'

export type PipelineStage = 'dedupe' | 'store' | 'publish' | 'replay' | 'event'

export interface PipelineMessages {
  upsert(message: NewStoredMessage): Promise<unknown>
  updateAck(sessionId: string, id: string, ack: number): Promise<boolean>
  markEmitted(sessionId: string, ids: string[], at: Date): Promise<number>
  listUnemitted(sessionId: string, chatId?: string): Promise<StoredMessage[]>
}

export interface SessionPipelineOptions {
  sessionId: string
  // false when the session or the whole gateway turned ordering off
  orderingEnabled: boolean
  order: OrderBufferOptions
  storeBodies: boolean
  // How long after a failed publish the chat is replayed from the database; every new failure of
  // the chat doubles it, up to the maximum
  replayDelayMs: number
  maxReplayDelayMs: number
  fetchTimeoutMs: number
}

export interface SessionPipelineDeps {
  client: Pick<WhatsAppClientPort, 'onEvent' | 'onSkipped' | 'fetchMessages'>
  messages: PipelineMessages
  sequencer: EventSequencer
  // true the first time a key is seen (Redis SET NX EX)
  claim(key: string): Promise<boolean>
  // Gives a claim back, so a repeat of the event is processed
  unclaim(key: string): Promise<void>
  // A live incoming message was stored (not a recovered one), written by the sender at `sentAt`
  noteIncoming(sentAt: Date): void
  metrics: Metrics
}

// A failing stage logs once per this long; every failure is still counted
const LOG_INTERVAL_MS = 10_000

type MessageEventName = 'message' | 'message_create'
type MessageEvent = Extract<ClientEvent, { event: MessageEventName }>

const isMessageEvent = (event: ClientEvent): event is MessageEvent =>
  event.event === 'message' || event.event === 'message_create'

// ClientEvent pairs each name with its data; the generic Emit cannot follow that through the union
const emitClientEvent = (emit: Emit, event: ClientEvent): Promise<void> =>
  (emit as (name: WaEventName, data: unknown) => Promise<void>)(event.event, event.data)

// The path of the events of ONE session: dedupe, store, order, stamp, publish. Events are handled
// one at a time in the order they arrive, so the steps cannot reorder them; the publishing itself
// goes through the sequencer. A new instance is built on every session start, since closing the
// order buffer is permanent.
export class SessionEventPipeline {
  private readonly logger = new Logger(SessionEventPipeline.name)
  private readonly buffer: InboundOrderBuffer<ClientEvent> | undefined
  // The event each held message arrived as, to publish it under the same name
  private readonly heldAs = new Map<string, MessageEventName>()
  private readonly replays = new Map<string, NodeJS.Timeout>()
  // Failed replays in a row per chat, for the backoff
  private readonly replayFailures = new Map<string, number>()
  // Direct publishes in flight (publish + mark as emitted), for `close` to wait for
  private readonly publishing = new Set<Promise<void>>()
  // The messages those publishes carry, so a recovery does not publish them a second time
  private readonly inFlight = new Set<string>()
  // The messages of a burst that went out before its publishing failed: the batch of the rest of
  // the burst includes them, so a bot that only reads `message_batch` does not miss them
  private readonly carried = new Map<string, { messages: MessageDto[]; reason: BatchReason }>()
  // Events about a message whose batch failed before it: they go out right behind it on the replay
  private readonly orphans = new Map<string, ClientEvent[]>()
  // Ids marked as emitted while a read of the table is running, which that read may still list
  private readonly readers = new Set<Set<string>>()
  private readonly lastLogged = new Map<PipelineStage, number>()
  private intake: Promise<void> = Promise.resolve()
  private stopListening: (() => void) | undefined
  private stopListeningSkipped: (() => void) | undefined
  private closed = false

  constructor(
    private readonly options: SessionPipelineOptions,
    private readonly deps: SessionPipelineDeps
  ) {
    this.buffer = options.orderingEnabled
      ? new InboundOrderBuffer<ClientEvent>(options.sessionId, options.order, {
          fetchChatOrder: (chatId, limit) =>
            withTimeout(
              deps.client.fetchMessages(chatId, { limit }),
              options.fetchTimeoutMs,
              'fetchMessages'
            ),
          release: batch => this.track(this.release(batch)),
          releaseFollowers: (_chatId, followers) => this.track(this.releaseFollowers(followers))
        })
      : undefined
  }

  start(): void {
    if (this.closed) return
    this.stopListening = this.deps.client.onEvent(event => this.accept(event))
    this.stopListeningSkipped = this.deps.client.onSkipped(event => {
      this.deps.metrics.eventsSkipped.inc({ event })
    })
  }

  // Stops listening and drops what the buffer holds (it stays stored, unpublished, for the next
  // start). Resolves once the work already in flight has finished.
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopListening?.()
    this.stopListeningSkipped?.()
    this.buffer?.close()
    for (const timer of this.replays.values()) clearTimeout(timer)
    this.replays.clear()
    this.orphans.clear()
    await Promise.allSettled([this.intake, ...this.publishing])
  }

  // Messages the reconciliation found that no event delivered. They take the same path as a live
  // message (dedupe, store, order buffer) behind the events already queued, and leave in a burst of
  // reason `reconcile`. Resolves with how many were new once they are stored; their publishing
  // follows the order buffer. Zero when the pipeline is closed.
  reconcile(messages: MessageDto[]): Promise<number> {
    return new Promise(resolve => {
      this.enqueue(async () => {
        resolve(await this.admit(messages))
      })
    })
  }

  private accept(event: ClientEvent): void {
    if (this.closed) return
    this.deps.metrics.events.inc({ event: event.event })
    this.enqueue(() => this.process(event))
  }

  // Every task catches its own failures, so the chain never breaks
  private enqueue(task: () => Promise<void>): void {
    this.intake = this.intake.then(task)
  }

  private async process(event: ClientEvent): Promise<void> {
    try {
      const key = this.dedupeKey(event)
      if (this.closed || (key !== undefined && !(await this.claim(key)))) return
      // A message that was not stored cannot be replayed: its repeat must not be taken for a duplicate
      const stored = await this.store(event)
      if (!stored && key !== undefined) await this.unclaim(key)
      // Only what is stored moves the baseline: a message that was not cannot be replayed
      if (stored && isMessageEvent(event) && !event.data.fromMe) {
        this.deps.noteIncoming(new Date(event.data.sentAt))
      }
      this.route(event)
      if (event.event === 'ready') await this.recover()
    } catch (error) {
      this.fail('event', error)
    }
  }

  private async admit(messages: MessageDto[]): Promise<number> {
    let admitted = 0
    for (const message of messages) {
      if (this.closed) break
      try {
        const event: ClientEvent = { event: 'message', data: message }
        const key = this.dedupeKey(event)
        if (key !== undefined && !(await this.claim(key))) continue
        if (!(await this.store(event))) {
          if (key !== undefined) await this.unclaim(key)
          continue
        }
        this.hold(message, 'reconcile')
        admitted++
      } catch (error) {
        this.fail('event', error)
      }
    }
    return admitted
  }

  private dedupeKey(event: ClientEvent): string | undefined {
    const suffix = dedupeSuffix(event)
    return suffix === undefined
      ? undefined
      : `dedupe:${this.options.sessionId}:${event.event}:${suffix}`
  }

  // Redis down must not stop the stream: without the check a duplicate may get through, and
  // delivery is at-least-once anyway
  private async claim(key: string): Promise<boolean> {
    try {
      return await this.deps.claim(key)
    } catch (error) {
      this.fail('dedupe', error)
      return true
    }
  }

  private async unclaim(key: string): Promise<void> {
    try {
      await this.deps.unclaim(key)
    } catch (error) {
      this.fail('dedupe', error)
    }
  }

  // false when the event could not be stored
  private async store(event: ClientEvent): Promise<boolean> {
    const { sessionId, storeBodies } = this.options
    try {
      if (isMessageEvent(event)) {
        await this.deps.messages.upsert(toNewStoredMessage(sessionId, event.data, storeBodies))
      } else if (event.event === 'message_ack') {
        await this.deps.messages.updateAck(sessionId, event.data.message.id, event.data.ack)
      }
      return true
    } catch (error) {
      this.fail('store', error)
      return false
    }
  }

  private route(event: ClientEvent): void {
    if (isMessageEvent(event)) {
      const message = event.data
      // The twin event of a message that is held (message and message_create) waits behind it
      if (this.buffer?.holdBehind(message.id, event)) return
      if (this.buffer?.offer(message)) {
        this.heldAs.set(message.id, event.event)
        return
      }
    } else {
      const target = followedMessageId(event)
      if (target !== undefined && this.buffer?.holdBehind(target, event)) return
    }
    this.publishNow(event)
  }

  private publishNow(event: ClientEvent): void {
    const messageId = isMessageEvent(event) ? event.data.id : undefined
    if (messageId !== undefined) this.inFlight.add(messageId)
    const flow = this.deps.sequencer
      .run(this.options.sessionId, async emit => {
        if (this.closed) return false
        await emitClientEvent(emit, event)
        return true
      })
      .then(async published => {
        if (published && isMessageEvent(event)) {
          this.replayFailures.delete(event.data.chatId)
          await this.markEmitted([event.data.id])
        }
      })
      .catch((error: unknown) => {
        this.fail('publish', error)
        // Only incoming messages are stored for replay
        if (isMessageEvent(event) && !event.data.fromMe) this.scheduleReplay(event.data.chatId)
      })
    this.publishing.add(flow)
    void flow.finally(() => {
      this.publishing.delete(flow)
      if (messageId !== undefined) this.inFlight.delete(messageId)
    })
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined
    )
    this.publishing.add(settled)
    void settled.then(() => this.publishing.delete(settled))
    return work
  }

  // Publishes one released batch in order. If stamping fails halfway, the messages not yet out stay
  // with `emittedAt` null and the chat is replayed from the database.
  private async release(batch: ReleasedBatch<ClientEvent>): Promise<void> {
    const published: MessageDto[] = []
    let failed = false
    await this.deps.sequencer.run(this.options.sessionId, async emit => {
      if (this.closed) return
      try {
        for (const { message, followers } of batch.items) {
          // A pipeline that closed halfway leaves the rest stored, for the next start
          if (this.closed) return
          await emit(this.heldAs.get(message.id) ?? 'message', message)
          published.push(message)
          this.countHeld(message)
          await this.emitFollowers(emit, [...(this.orphans.get(message.id) ?? []), ...followers])
          this.orphans.delete(message.id)
        }
      } catch (error) {
        failed = true
        this.fail('publish', error)
        return
      }
      const summary = this.summaryOf(batch)
      if (!summary) return
      try {
        await emit('message_batch', summary)
      } catch (error) {
        // The messages are out; the summary is not worth a replay that would repeat them
        this.fail('publish', error)
      }
    })
    if (!this.closed) this.forget(batch, published)
    this.keepForReplay(batch, published, failed)
    await this.markEmitted(published.map(message => message.id))
    if (!failed) this.replayFailures.delete(batch.chatId)
    else if (this.hasIncomingLeft(batch, published)) this.scheduleReplay(batch.chatId)
  }

  // Only incoming messages are stored for replay: a batch of our own messages has nothing to replay
  private hasIncomingLeft(batch: ReleasedBatch<ClientEvent>, published: MessageDto[]): boolean {
    const done = new Set(published.map(message => message.id))
    return batch.items.some(({ message }) => !message.fromMe && !done.has(message.id))
  }

  // What was published is done with; what was not keeps its name and its followers for the replay
  private forget(batch: ReleasedBatch<ClientEvent>, published: MessageDto[]): void {
    const done = new Set(published.map(message => message.id))
    for (const { message, followers } of batch.items) {
      if (done.has(message.id)) {
        this.heldAs.delete(message.id)
      } else if (followers.length > 0) {
        this.orphans.set(message.id, [...(this.orphans.get(message.id) ?? []), ...followers])
      }
    }
  }

  // The batch the buffer built, or one that adds the messages of the same burst a failure left out
  private summaryOf(batch: ReleasedBatch<ClientEvent>): MessageBatch | undefined {
    const carried = this.carried.get(batch.chatId)
    if (!carried) return batch.batch
    // A message that went out but was not marked comes back in the replay: it counts once
    const seen = new Set<string>()
    const messages = [...carried.messages, ...batch.items.map(item => item.message)].filter(
      message => !seen.has(message.id) && Boolean(seen.add(message.id))
    )
    return buildBatch(batch.chatId, messages, carried.reason)
  }

  private keepForReplay(
    batch: ReleasedBatch<ClientEvent>,
    published: MessageDto[],
    failed: boolean
  ): void {
    const carried = this.carried.get(batch.chatId)
    if (!failed) {
      this.carried.delete(batch.chatId)
    } else if (published.length > 0 || carried) {
      this.carried.set(batch.chatId, {
        messages: [...(carried?.messages ?? []), ...published],
        reason: carried?.reason ?? batch.reason
      })
    }
  }

  private async releaseFollowers(followers: ClientEvent[]): Promise<void> {
    await this.deps.sequencer.run(this.options.sessionId, async emit => {
      if (!this.closed) await this.emitFollowers(emit, followers)
    })
  }

  // Events about a message are not stored: one that fails is dropped, the message is not affected
  private async emitFollowers(emit: Emit, followers: ClientEvent[]): Promise<void> {
    for (const follower of followers) {
      if (this.closed) return
      try {
        await emitClientEvent(emit, follower)
      } catch (error) {
        this.fail('publish', error)
      }
    }
  }

  private countHeld(message: MessageDto): void {
    const { metrics } = this.deps
    if (!message.ordering) return
    metrics.orderingHeld.inc()
    if (message.ordering.reordered) metrics.orderingReordered.inc()
    metrics.orderingHoldSeconds.observe(message.ordering.heldMs / 1000)
  }

  // A failure here leaves the rows unpublished, so a later recovery would publish them again:
  // at-least-once, and the consumers drop duplicates by message id
  private async markEmitted(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    for (const reader of this.readers) for (const id of ids) reader.add(id)
    try {
      await this.deps.messages.markEmitted(this.options.sessionId, ids, new Date())
    } catch (error) {
      this.fail('store', error)
    }
  }

  // Feeds the stored, unpublished messages of the session back through the order buffer. It runs on
  // every `ready`: after a crash, a restart, or a reconnect.
  private async recover(): Promise<void> {
    try {
      this.feed(await this.listUnemitted())
    } catch (error) {
      this.fail('replay', error)
    }
  }

  // Without the rows marked as emitted while the query ran: a batch can finish after the database
  // answered and before the rows are fed, and those would be published a second time
  private async listUnemitted(chatId?: string): Promise<StoredMessage[]> {
    const emittedMeanwhile = new Set<string>()
    this.readers.add(emittedMeanwhile)
    try {
      const rows = await this.deps.messages.listUnemitted(this.options.sessionId, chatId)
      return rows.filter(row => !emittedMeanwhile.has(row.id))
    } finally {
      this.readers.delete(emittedMeanwhile)
    }
  }

  private scheduleReplay(chatId: string): void {
    if (this.closed || this.replays.has(chatId)) return
    const failures = this.replayFailures.get(chatId) ?? 0
    this.replayFailures.set(chatId, failures + 1)
    const delayMs = Math.min(
      this.options.replayDelayMs * 2 ** failures,
      this.options.maxReplayDelayMs
    )
    const timer = setTimeout(() => {
      this.replays.delete(chatId)
      this.enqueue(() => this.replayChat(chatId))
    }, delayMs)
    this.replays.set(chatId, timer)
  }

  private async replayChat(chatId: string): Promise<void> {
    if (this.closed) return
    try {
      const rows = await this.listUnemitted(chatId)
      // Nothing left to replay: what a failed batch carried belongs to a burst that is over
      if (rows.length === 0) {
        this.carried.delete(chatId)
        this.replayFailures.delete(chatId)
      }
      this.feed(rows)
    } catch (error) {
      this.fail('replay', error)
      this.scheduleReplay(chatId)
    }
  }

  // Rows come oldest first. The buffer sorts a chat on its own flush; without a buffer they go out
  // in this order.
  private feed(rows: StoredMessage[]): void {
    const unreadable: string[] = []
    for (const row of rows) {
      // Already on its way out: publishing it again would repeat it
      if (this.inFlight.has(row.id)) continue
      const message = toMessageDto(row)
      if (!message) {
        this.fail('replay', new Error('stored message does not fit the DTO'))
        unreadable.push(row.id)
        continue
      }
      this.hold(message, 'burst')
    }
    // It can never be published: leaving it unpublished would list and count it on every replay
    void this.markEmitted(unreadable)
  }

  // Into the order buffer even when the message is not late: it was stored first, so it must be
  // sorted with the others of its chat. Without a buffer it goes out as it comes.
  private hold(message: MessageDto, reason: BatchReason): void {
    if (!this.buffer) {
      this.publishNow({ event: 'message', data: message })
    } else if (this.buffer.offer(message, reason, true) && !this.heldAs.has(message.id)) {
      this.heldAs.set(message.id, 'message')
    }
  }

  // Identifiers and the error class only: an error message can echo message content. A stage that
  // keeps failing (Redis down) logs once per interval, so the log does not flood.
  private fail(stage: PipelineStage, error: unknown): void {
    this.deps.metrics.pipelineErrors.inc({ stage })
    const now = Date.now()
    const last = this.lastLogged.get(stage)
    if (last !== undefined && now - last < LOG_INTERVAL_MS) return
    this.lastLogged.set(stage, now)
    const kind = error instanceof Error ? error.name : typeof error
    const fields = refusedFields(error)
    this.logger.error(
      `Event pipeline ${stage} failed (session ${this.options.sessionId}): ${kind}${fields}`
    )
  }
}

// Prisma names the arguments it refused in a validation error, after a dump of the data that
// carries message content. Only the names of the columns we write are logged: the dump can
// contain any text, including something shaped like an argument.
const REFUSED_ARGUMENT = /argument `([\w.]+)`/gi
const COLUMNS: Record<keyof NewStoredMessage, true> = {
  id: true,
  sessionId: true,
  chatId: true,
  direction: true,
  fromMe: true,
  type: true,
  body: true,
  hasMedia: true,
  ack: true,
  sentAt: true,
  receivedAt: true,
  origin: true,
  dto: true
}

function refusedFields(error: unknown): string {
  if (!(error instanceof Error) || error.name !== 'PrismaClientValidationError') return ''
  const names = [...error.message.matchAll(REFUSED_ARGUMENT)]
    .map(match => match[1] ?? '')
    .filter((name, index, all) => name in COLUMNS && all.indexOf(name) === index)
  return names.length > 0 ? ` (fields: ${names.join(', ')})` : ''
}
