import { Logger } from '@nestjs/common'

import type { MessageDto } from '../types/dto.js'
import type { WaEventPayloadMap } from '../types/events.js'

export interface OrderBufferOptions {
  lateThresholdS: number
  windowMs: number
  maxHoldMs: number
  maxMessages: number
}

export type MessageBatch = WaEventPayloadMap['message_batch']
export type BatchReason = MessageBatch['reason']

// `followers` are the events about a held message (ack, edit, reaction, revoke) that arrived while
// it waited; they are released right behind it. Their type is the pipeline's business.
export interface ReleasedItem<F> {
  message: MessageDto
  followers: F[]
}

export interface ReleasedBatch<F> {
  chatId: string
  items: ReleasedItem<F>[]
  batch?: MessageBatch
}

export interface OrderBufferPorts<F> {
  // The chat as WhatsApp Web shows it, oldest first (`fetchMessages`)
  fetchChatOrder(chatId: string, limit: number): Promise<MessageDto[]>
  // Called one batch at a time per chat; the next one waits for the returned promise
  release(batch: ReleasedBatch<F>): Promise<void>
  // Followers that attached to a message while its batch was being released
  releaseFollowers(chatId: string, followers: F[]): Promise<void>
}

interface Entry<F> {
  message: MessageDto
  arrivedAt: number
  followers: F[]
}

interface ChatBuffer<F> {
  chatId: string
  entries: Entry<F>[]
  reason: BatchReason
  windowTimer: NodeJS.Timeout | undefined
  maxHoldTimer: NodeJS.Timeout | undefined
}

interface ChatState<F> {
  open: ChatBuffer<F> | undefined
  // Buffers closed but not yet released; while any exists, new messages must queue behind them
  pending: number
  tail: Promise<void>
}

interface SortKey<F> {
  entry: Entry<F>
  arrival: number
  sentMs: number
  receivedMs: number
  canonical: number
}

const compare = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0)

const byConversationOrder = <F>(a: SortKey<F>, b: SortKey<F>): number =>
  compare(a.sentMs, b.sentMs) ||
  compare(a.canonical, b.canonical) ||
  compare(a.receivedMs, b.receivedMs) ||
  compare(a.arrival, b.arrival)

// Per session. Holds the messages of a chat that arrived out of order (a contact that wrote
// offline and reconnected) until they can be published sorted by the time the sender wrote them.
// It decides and sorts; assigning `seq` and publishing belong to the pipeline, through `ports`.
export class InboundOrderBuffer<F> {
  private readonly logger = new Logger(InboundOrderBuffer.name)
  private readonly chats = new Map<string, ChatState<F>>()
  private readonly held = new Map<string, Entry<F>>()
  private closed = false

  constructor(
    private readonly sessionId: string,
    private readonly options: OrderBufferOptions,
    private readonly ports: OrderBufferPorts<F>
  ) {}

  // true: the buffer keeps the message and will release it; false: publish it right away
  offer(message: MessageDto, reason: BatchReason = 'burst'): boolean {
    if (this.closed) return false
    if (this.held.has(message.id)) return true

    const state = this.chats.get(message.chatId)
    const busy = state !== undefined && (state.open !== undefined || state.pending > 0)
    if (!busy && !this.isLate(message)) return false

    const chat = state ?? this.openState(message.chatId)
    const buffer = chat.open ?? this.openBuffer(chat, message.chatId)
    const entry: Entry<F> = { message, arrivedAt: Date.now(), followers: [] }
    buffer.entries.push(entry)
    this.held.set(message.id, entry)
    if (reason === 'reconcile') buffer.reason = 'reconcile'

    if (buffer.entries.length >= this.options.maxMessages) {
      this.startFlush(chat, buffer)
    } else {
      // Every arrival restarts the debounce; the max-hold timer was armed when the buffer opened
      clearTimeout(buffer.windowTimer)
      buffer.windowTimer = setTimeout(() => this.startFlush(chat, buffer), this.options.windowMs)
    }
    return true
  }

  // true: the message is held, so the follower is released right after it; false: publish it now
  holdBehind(messageId: string, follower: F): boolean {
    const entry = this.held.get(messageId)
    if (!entry) return false
    entry.followers.push(follower)
    return true
  }

  // Drops everything held without publishing. Those messages stay stored with `emittedAt` null,
  // and the pipeline feeds them back on the next `ready`.
  close(): void {
    this.closed = true
    for (const state of this.chats.values()) {
      if (state.open) this.clearTimers(state.open)
    }
    this.chats.clear()
    this.held.clear()
  }

  private isLate(message: MessageDto): boolean {
    const lagMs = Date.parse(message.receivedAt) - Date.parse(message.sentAt)
    return lagMs > this.options.lateThresholdS * 1000
  }

  private openState(chatId: string): ChatState<F> {
    const state: ChatState<F> = { open: undefined, pending: 0, tail: Promise.resolve() }
    this.chats.set(chatId, state)
    return state
  }

  private openBuffer(state: ChatState<F>, chatId: string): ChatBuffer<F> {
    const buffer: ChatBuffer<F> = {
      chatId,
      entries: [],
      reason: 'burst',
      windowTimer: undefined,
      maxHoldTimer: undefined
    }
    buffer.maxHoldTimer = setTimeout(() => this.startFlush(state, buffer), this.options.maxHoldMs)
    state.open = buffer
    return buffer
  }

  private clearTimers(buffer: ChatBuffer<F>): void {
    clearTimeout(buffer.windowTimer)
    clearTimeout(buffer.maxHoldTimer)
  }

  private startFlush(state: ChatState<F>, buffer: ChatBuffer<F>): void {
    if (state.open !== buffer) return
    this.clearTimers(buffer)
    state.open = undefined
    state.pending += 1
    // `flush` never rejects, so the chain never breaks
    state.tail = state.tail.then(() => this.flush(buffer)).then(() => this.settle(state, buffer))
  }

  private settle(state: ChatState<F>, buffer: ChatBuffer<F>): void {
    state.pending -= 1
    if (!state.open && state.pending === 0) this.chats.delete(buffer.chatId)
  }

  private async flush(buffer: ChatBuffer<F>): Promise<void> {
    if (this.closed) return
    const canonical = await this.canonicalOrder(buffer)
    if (this.closed) return

    const releasedAt = Date.now()
    const sorted = buffer.entries
      .map<SortKey<F>>((entry, arrival) => ({
        entry,
        arrival,
        sentMs: Date.parse(entry.message.sentAt),
        receivedMs: Date.parse(entry.message.receivedAt),
        // A message WhatsApp Web does not list sorts after the ones it does
        canonical: canonical.get(entry.message.id) ?? Number.POSITIVE_INFINITY
      }))
      .sort(byConversationOrder)

    const delivered = new Map<Entry<F>, number>()
    const items = sorted.map<ReleasedItem<F>>(({ entry, arrival }, position) => {
      delivered.set(entry, entry.followers.length)
      return {
        message: {
          ...entry.message,
          ordering: {
            held: true,
            reordered: position !== arrival,
            heldMs: Math.max(0, releasedAt - entry.arrivedAt)
          }
        },
        followers: [...entry.followers]
      }
    })

    try {
      await this.ports.release({
        chatId: buffer.chatId,
        items,
        ...this.digest(buffer, items)
      })
      await this.releaseLateFollowers(buffer, delivered)
    } catch (error) {
      // The rows keep `emittedAt` null, so the next boot feeds them back
      this.logFailure('release', error)
    } finally {
      this.forget(buffer)
    }
  }

  private forget(buffer: ChatBuffer<F>): void {
    for (const entry of buffer.entries) this.held.delete(entry.message.id)
  }

  // Every message of the burst, own ones included, so a bot sees what was already answered. The
  // batch exists only when the contact wrote two or more of them.
  private digest(
    buffer: ChatBuffer<F>,
    items: ReleasedItem<F>[]
  ): { batch: MessageBatch } | Record<string, never> {
    const messages = items.map(item => item.message)
    const first = messages[0]
    const last = messages.at(-1)
    const fromContact = messages.filter(message => !message.fromMe).length
    if (fromContact < 2 || !first || !last) return {}

    const origin = messages.find(message => message.origin)?.origin
    return {
      batch: {
        chatId: buffer.chatId,
        messages,
        firstSentAt: first.sentAt,
        lastSentAt: last.sentAt,
        count: messages.length,
        ...(origin && { origin }),
        reason: buffer.reason
      }
    }
  }

  // A follower may arrive while `release` awaits, after the snapshot of `items` was taken
  private async releaseLateFollowers(
    buffer: ChatBuffer<F>,
    delivered: Map<Entry<F>, number>
  ): Promise<void> {
    for (;;) {
      if (this.closed) return
      const late: F[] = []
      for (const entry of buffer.entries) {
        const from = delivered.get(entry) ?? 0
        late.push(...entry.followers.slice(from))
        delivered.set(entry, entry.followers.length)
      }
      if (late.length === 0) {
        // Same turn as the check: a later `holdBehind` must find the message gone, not attach to it
        this.forget(buffer)
        return
      }
      try {
        await this.ports.releaseFollowers(buffer.chatId, late)
      } catch (error) {
        // These events are dropped, not retried; the messages themselves were already published
        this.logFailure('follower release', error)
      }
    }
  }

  private async canonicalOrder(buffer: ChatBuffer<F>): Promise<Map<string, number>> {
    const order = new Map<string, number>()
    try {
      const messages = await this.ports.fetchChatOrder(buffer.chatId, buffer.entries.length + 5)
      messages.forEach((message, index) => order.set(message.id, index))
    } catch (error) {
      // Without it, ties fall back to receivedAt and arrival order
      this.logFailure('chat order fetch', error)
    }
    return order
  }

  // Identifiers and the error class only: an error message can echo message content
  private logFailure(step: string, error: unknown): void {
    const kind = error instanceof Error ? error.name : typeof error
    this.logger.error(`Order buffer ${step} failed (session ${this.sessionId}): ${kind}`)
  }
}
