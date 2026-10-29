import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap
} from '@nestjs/common'
import { z } from 'zod'

import { ConflictError, NotFoundError } from '../common/errors.js'
import { backoffCeilingMs } from '../common/lib/retry.js'
import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Session } from '../database/models.js'
import {
  SessionsRepository,
  type NewSession,
  type SessionPatch
} from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { RedisService } from '../infra/redis/redis.service.js'
import { SESSION_STATUSES, type SessionStatus } from '../types/dto.js'

import { EventPipelineService } from './event-pipeline.service.js'
import {
  WHATSAPP_CLIENT_FACTORY,
  type ClientEvent,
  type WhatsAppClientFactory,
  type WhatsAppClientPort
} from './whatsapp-client.port.js'

const RECONNECT_BASE_DELAY_MS = 5000
const RECONNECT_MAX_DELAY_MS = 300_000
// Destroying a browser that hangs must not hold the session (or the shutdown) for ever
const CALL_TIMEOUT_MS = 15_000
const REDIS_TIMEOUT_MS = 5000
const DB_TIMEOUT_MS = 5000
const SCAN_COUNT = 200

// What the manager reads of `Session.settings`; the rest of the object belongs to other services
const SessionSettings = z.looseObject({
  ordering: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  autoDownloadAudio: z.boolean().optional(),
  autoDownloadDocuments: z.boolean().optional(),
  autoDownloadPhotos: z.boolean().optional(),
  autoDownloadVideos: z.boolean().optional(),
  backgroundSync: z.boolean().optional()
})
type SessionSettings = z.infer<typeof SessionSettings>

// The client call that applies each flag of the settings every time the session is ready
const SETTING_CALLS = [
  ['autoDownloadAudio', 'setAutoDownloadAudio'],
  ['autoDownloadDocuments', 'setAutoDownloadDocuments'],
  ['autoDownloadPhotos', 'setAutoDownloadPhotos'],
  ['autoDownloadVideos', 'setAutoDownloadVideos'],
  ['backgroundSync', 'setBackgroundSync']
] as const

// The statuses a session has when nothing runs for it
const STATUSES_WITHOUT_CLIENT: readonly SessionStatus[] = ['created', 'stopped', 'failed']

export interface StartOptions {
  // Log in with a phone number instead of a QR code
  pairingPhoneNumber?: string
}

// A session that has a client, as the watchdog sees it. `generation` identifies the run: once it
// changes, whatever the watchdog saw about that run no longer holds.
export interface RunningSession {
  id: string
  status: SessionStatus
  generation: number
  client: WhatsAppClientPort
  // When the session entered `starting` or `authenticating`; undefined in any other status
  phaseStartedAt: number | undefined
}

// Why the watchdog acts; it is the `code` of the `session_error` event the consumers get
export type WatchdogCode =
  'WATCHDOG_START_TIMEOUT' | 'WATCHDOG_HEALTH_CHECK' | 'WATCHDOG_BLOCKED_STATE' | 'WATCHDOG_MEMORY'

// What a request of the watchdog names to be sure it is about the run it looked at
export type RunRef = Pick<RunningSession, 'id' | 'generation' | 'status' | 'phaseStartedAt'>

// Everything a session that has a client, or is about to get one again, keeps in memory
interface Runtime {
  client: WhatsAppClientPort | undefined
  // Raised on every start and teardown; a callback of an older client sees another number and quits
  generation: number
  phaseStartedAt: number | undefined
  qr: string | undefined
  pairingPhoneNumber: string | undefined
  reconnectAttempts: number
  reconnectTimer: NodeJS.Timeout | undefined
  unsubscribe: (() => void) | undefined
}

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error)

const parseSettings = (settings: unknown): SessionSettings => {
  const parsed = SessionSettings.safeParse(settings)
  return parsed.success ? parsed.data : {}
}

// Owns the life of every session: its client, its status (TDD §5.2) and the way back from a drop
// (TDD §6.5). The database holds what exists and the last status; the map holds what is running.
// Every command and every client event of one session runs through one queue, so a stop cannot
// overlap a ready, and `statuses` is the single place a status is read.
@Injectable()
export class SessionManager implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SessionManager.name)
  private readonly runtimes = new Map<string, Runtime>()
  // Every session of the database, running or not
  private readonly statuses = new Map<string, SessionStatus>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly removedListeners = new Set<(sessionId: string) => Promise<void>>()
  private shuttingDown = false
  private restoreTimer: NodeJS.Timeout | undefined
  private wakeRestore: (() => void) | undefined

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(EventPipelineService) private readonly pipeline: EventPipelineService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(WHATSAPP_CLIENT_FACTORY) private readonly createClient: WhatsAppClientFactory
  ) {}

  // ---- Boot and shutdown -----------------------------------------------------------------------

  // Does not block the application: the sessions start one after another in the background
  onApplicationBootstrap(): void {
    void this.restore().catch((error: unknown) => {
      this.logger.error(`Restoring the sessions failed (${errorKind(error)})`)
    })
  }

  // Destroys every client without logging out, so the next boot finds the sessions linked
  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true
    clearTimeout(this.restoreTimer)
    this.wakeRestore?.()
    // Through the queue of each session, behind a start or a drop that is in flight
    await Promise.all(
      [...this.runtimes].map(([id, runtime]) =>
        this.exclusive(id, () => this.teardown(id, runtime))
      )
    )
    this.runtimes.clear()
    // Then the pipelines and the `seq` bounds, while the database is still open (Nest closes the
    // connections in `onApplicationShutdown`, after every `beforeApplicationShutdown`)
    await this.pipeline.closeAll()
  }

  // ---- Commands --------------------------------------------------------------------------------

  create(id: string, options: Omit<NewSession, 'id'> = {}): Promise<Session> {
    return this.exclusive(id, async () => {
      if (await this.sessions.findById(id)) {
        throw new ConflictError('SESSION_ALREADY_EXISTS', `Session ${id} already exists`)
      }
      this.assertCapacity(id)
      const session = await this.sessions.create({ id, ...options })
      this.setKnownStatus(id, session.status)
      return session
    })
  }

  // A session that is already running is left as it is
  start(id: string, options: StartOptions = {}): Promise<Session> {
    return this.exclusive(id, async () => {
      const session = await this.requireRow(id)
      if (this.runtimes.has(id) || this.shuttingDown) return session
      this.assertCapacity(id)
      // Starting on purpose undoes a stop or a logout: the session comes back at the next boot
      if (!session.autoStart) await this.sessions.update(id, { autoStart: true })
      const runtime = this.newRuntime(id, options.pairingPhoneNumber)
      await this.launch(id, runtime, session)
      return (await this.sessions.findById(id)) ?? session
    })
  }

  // Stopped on purpose: it does not come back at the next boot either
  stop(id: string): Promise<Session> {
    return this.exclusive(id, async () => {
      await this.requireRow(id)
      return this.halt(id, 'stopped', { autoStart: false })
    })
  }

  // Stop and start again, keeping `autoStart` as it was
  restart(id: string): Promise<Session> {
    return this.exclusive(id, async () => {
      const session = await this.requireRow(id)
      if (this.shuttingDown) return session
      this.assertCapacity(id)
      if (this.runtimes.has(id)) await this.halt(id, 'stopped')
      const runtime = this.newRuntime(id, undefined)
      await this.launch(id, runtime, session)
      return (await this.sessions.findById(id)) ?? session
    })
  }

  // Unlinks the account: the next start asks for a QR code again
  logout(id: string): Promise<Session> {
    return this.exclusive(id, async () => {
      await this.requireRow(id)
      return this.unlink(id)
    })
  }

  // Deletes the session with its keys, tokens and messages
  remove(id: string): Promise<void> {
    return this.exclusive(id, async () => {
      await this.requireRow(id)
      const runtime = this.runtimes.get(id)
      if (runtime) {
        await this.logoutBestEffort(id, runtime)
        await this.teardown(id, runtime)
        this.runtimes.delete(id)
      }
      try {
        await this.sessions.delete(id)
      } catch (error: unknown) {
        // The client is gone, so the status must say so
        await this.transition(id, 'stopped', {})
        throw error
      }
      this.statuses.delete(id)
      this.refreshGauge()
      this.pipeline.forget(id)
      await this.deleteRedisKeys(id)
      for (const listener of this.removedListeners) await listener(id)
    })
  }

  // For the services that keep something per session (the send queue): they hear of a deleted session
  // after its row and keys are gone. A listener that throws fails the deletion call, not the deletion.
  onRemoved(listener: (sessionId: string) => Promise<void>): () => void {
    this.removedListeners.add(listener)
    return () => this.removedListeners.delete(listener)
  }

  resetState(id: string): Promise<void> {
    return this.requireReady(id).resetState()
  }

  // ---- Reads -----------------------------------------------------------------------------------

  status(id: string): SessionStatus {
    const status = this.statuses.get(id)
    if (!status) throw new NotFoundError('NOT_FOUND', `Session ${id} does not exist`)
    return status
  }

  // The latest QR code, only while the session waits for a scan; it never reaches the database
  qr(id: string): string | undefined {
    this.status(id)
    return this.runtimes.get(id)?.qr
  }

  // The client of a session that is ready; what every operation of the API goes through
  requireReady(id: string): WhatsAppClientPort {
    const status = this.status(id)
    const client = this.runtimes.get(id)?.client
    if (status !== 'ready' || !client) {
      throw new ConflictError('SESSION_NOT_READY', `Session ${id} is ${status}, not ready`)
    }
    return client
  }

  // ---- Watchdog entry points -------------------------------------------------------------------

  running(): RunningSession[] {
    const sessions: RunningSession[] = []
    for (const [id, runtime] of this.runtimes) {
      const status = this.statuses.get(id)
      if (!status || !runtime.client) continue
      sessions.push({
        id,
        status,
        generation: runtime.generation,
        client: runtime.client,
        phaseStartedAt: runtime.phaseStartedAt
      })
    }
    return sessions
  }

  // Both do nothing when the run is not the one the watchdog looked at (it ended, or went on to
  // another phase while the request waited in the queue) or when the gateway is shutting down
  reconnectRun(run: RunRef, code: WatchdogCode, reason: string): Promise<void> {
    return this.exclusive(run.id, async () => {
      const runtime = this.currentRuntime(run)
      if (!runtime) return
      this.metrics.metrics.watchdogRestarts.inc()
      await this.announceError(run.id, code, reason)
      await this.reconnect(run.id, runtime, reason)
    })
  }

  // For a state that a new browser would not fix: no retry until someone starts the session
  failRun(run: RunRef, code: WatchdogCode, reason: string): Promise<void> {
    return this.exclusive(run.id, async () => {
      const runtime = this.currentRuntime(run)
      if (!runtime) return
      await this.announceError(run.id, code, reason)
      await this.fail(run.id, runtime, reason)
    })
  }

  // Tells the consumers before the session moves, so `session_error` comes before the new status.
  // A failure to tell is logged and never stops the remedy.
  private async announceError(id: string, code: WatchdogCode, message: string): Promise<void> {
    try {
      await withTimeout(
        this.pipeline.publish(id, 'session_error', { code, message }),
        REDIS_TIMEOUT_MS,
        'publish session_error'
      )
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Publishing session_error failed (${errorKind(error)})`)
    }
  }

  private currentRuntime(run: RunRef): Runtime | undefined {
    const runtime = this.runtimes.get(run.id)
    if (this.shuttingDown || !runtime) return undefined
    const same =
      runtime.generation === run.generation &&
      runtime.phaseStartedAt === run.phaseStartedAt &&
      this.statuses.get(run.id) === run.status
    return same ? runtime : undefined
  }

  // ---- Lifecycle -------------------------------------------------------------------------------

  // Builds the client and the pipeline, then lets the browser start. The pipeline listens before
  // `initialize`, since an event emitted earlier would not be seen.
  private async launch(id: string, runtime: Runtime, session: Session): Promise<void> {
    if (this.shuttingDown) return
    const generation = ++runtime.generation
    try {
      const client = this.createClient(
        id,
        runtime.pairingPhoneNumber
          ? { pairWithPhoneNumber: { phoneNumber: runtime.pairingPhoneNumber } }
          : {}
      )
      runtime.client = client
      await this.pipeline.open(id, client, {
        orderingEnabled: parseSettings(session.settings).ordering?.enabled ?? true
      })
      // The shutdown came while the pipeline opened: nothing may start a browser now
      if (this.shuttingDown) {
        await this.teardown(id, runtime)
        return
      }
      runtime.unsubscribe = client.onEvent(event =>
        this.onClientEvent(id, runtime, generation, event)
      )
      runtime.phaseStartedAt = Date.now()
      await this.transition(id, 'starting', {})
      // Not awaited: a browser that is slow to start must not hold the queue of the session
      void client.initialize().catch((error: unknown) => {
        this.run(id, 'Reconnecting after a failed initialize', () =>
          runtime.generation === generation
            ? this.reconnect(id, runtime, `initialize failed (${errorKind(error)})`)
            : Promise.resolve()
        )
      })
    } catch (error: unknown) {
      await this.reconnect(id, runtime, `start failed (${errorKind(error)})`)
    }
  }

  // The way back from a drop: destroy the client, wait, start again. Gives up as `failed` when
  // SESSION_RECONNECT_MAX_ATTEMPTS is finite and spent.
  private async reconnect(id: string, runtime: Runtime, reason: string): Promise<void> {
    await this.teardown(id, runtime)
    runtime.reconnectAttempts++
    const max = this.config.SESSION_RECONNECT_MAX_ATTEMPTS
    if (max > 0 && runtime.reconnectAttempts > max) {
      await this.fail(id, runtime, 'reconnect attempts exhausted')
      return
    }
    await this.transition(id, 'disconnected', { lastError: reason }, reason)
    const delayMs = this.reconnectDelayMs(runtime.reconnectAttempts)
    this.logger.warn(
      `[${id}] Reconnect attempt ${runtime.reconnectAttempts} in ${Math.round(delayMs / 1000)} s`
    )
    runtime.reconnectTimer = setTimeout(() => {
      this.run(id, 'Reconnecting', () => this.relaunch(id, runtime))
    }, delayMs)
  }

  private async relaunch(id: string, runtime: Runtime): Promise<void> {
    if (this.runtimes.get(id) !== runtime || this.shuttingDown) return
    runtime.reconnectTimer = undefined
    const session = await this.sessions.findById(id)
    if (!session) {
      this.runtimes.delete(id)
      return
    }
    await this.launch(id, runtime, session)
  }

  // Needs a person: no retry until someone starts the session
  private async fail(id: string, runtime: Runtime, reason: string): Promise<void> {
    await this.teardown(id, runtime)
    this.runtimes.delete(id)
    await this.transition(id, 'failed', { lastError: reason }, reason)
  }

  // Closes the pipeline before it destroys the client: the pipeline still asks the client for the
  // chat order while it flushes what it holds
  private async teardown(id: string, runtime: Runtime): Promise<void> {
    runtime.generation++
    clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = undefined
    runtime.unsubscribe?.()
    runtime.unsubscribe = undefined
    runtime.phaseStartedAt = undefined
    runtime.qr = undefined
    const client = runtime.client
    runtime.client = undefined
    try {
      await this.pipeline.close(id)
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Closing the pipeline failed (${errorKind(error)})`)
    }
    if (!client) return
    try {
      await withTimeout(client.destroy(), CALL_TIMEOUT_MS, 'destroy')
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Destroying the client failed (${errorKind(error)})`)
    }
  }

  // Ends the run of a session, whether or not it has one
  private async halt(
    id: string,
    status: SessionStatus,
    patch: SessionPatch = {}
  ): Promise<Session> {
    const runtime = this.runtimes.get(id)
    if (runtime) {
      await this.teardown(id, runtime)
      this.runtimes.delete(id)
    }
    await this.transition(id, status, patch)
    return this.requireRow(id)
  }

  private async unlink(id: string): Promise<Session> {
    const client = this.runtimes.get(id)?.client
    if (!client) {
      throw new ConflictError('SESSION_NOT_READY', `Session ${id} has no client to log out`)
    }
    await withTimeout(client.logout(), CALL_TIMEOUT_MS, 'logout')
    return this.markLoggedOut(id)
  }

  private async logoutBestEffort(id: string, runtime: Runtime): Promise<void> {
    if (!runtime.client) return
    try {
      await withTimeout(runtime.client.logout(), CALL_TIMEOUT_MS, 'logout')
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Logout before the delete failed (${errorKind(error)})`)
    }
  }

  private markLoggedOut(id: string): Promise<Session> {
    return this.halt(id, 'created', {
      autoStart: false,
      phoneNumber: null,
      pushName: null,
      linkedAt: null,
      lastError: null
    })
  }

  // ---- Client events ---------------------------------------------------------------------------

  private onClientEvent(
    id: string,
    runtime: Runtime,
    generation: number,
    event: ClientEvent
  ): void {
    this.run(id, `Handling ${event.event}`, () =>
      runtime.generation === generation ? this.handleEvent(id, runtime, event) : Promise.resolve()
    )
  }

  private async handleEvent(id: string, runtime: Runtime, event: ClientEvent): Promise<void> {
    switch (event.event) {
      case 'qr':
        runtime.qr = event.data.qr
        runtime.phaseStartedAt = undefined
        await this.transition(id, 'qr', {})
        return
      case 'code':
        runtime.phaseStartedAt = undefined
        await this.transition(id, 'pairing_code', {})
        return
      case 'authenticated':
        runtime.qr = undefined
        // The time a person took to scan the code is not the time the browser took to load
        runtime.phaseStartedAt = Date.now()
        await this.transition(id, 'authenticating', {})
        return
      case 'ready':
        await this.onReady(id, runtime)
        return
      case 'auth_failure':
        await this.fail(id, runtime, 'auth failure')
        return
      case 'disconnected':
        if (event.data.reason === 'LOGOUT') {
          await this.markLoggedOut(id)
        } else {
          await this.reconnect(id, runtime, `disconnected (${event.data.reason})`)
        }
        return
      case 'session_error':
        await this.reconnect(id, runtime, `session error (${event.data.code})`)
        return
      case 'change_state':
        // With the takeover on, the adapter takes the session back itself
        if (event.data.state === 'CONFLICT' && !this.config.TAKEOVER_ON_CONFLICT) {
          await this.fail(id, runtime, 'WhatsApp Web is open somewhere else (CONFLICT)')
        }
        return
      default:
        return
    }
  }

  private async onReady(id: string, runtime: Runtime): Promise<void> {
    const client = runtime.client
    if (!client) return
    runtime.qr = undefined
    runtime.phaseStartedAt = undefined
    runtime.reconnectAttempts = 0
    const patch: SessionPatch = { lastConnectedAt: new Date(), lastError: null }
    try {
      const info = await withTimeout(client.getClientInfo(), CALL_TIMEOUT_MS, 'getClientInfo')
      patch.phoneNumber = info.wid.split('@')[0] ?? null
      patch.pushName = info.pushname
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Reading the account failed (${errorKind(error)})`)
    }
    const row = await this.sessions.findById(id)
    if (row && !row.linkedAt) patch.linkedAt = new Date()
    await this.transition(id, 'ready', patch)
    await this.applySettings(id, client, parseSettings(row?.settings))
  }

  // A failing call is logged and skipped: the session is usable without it
  private async applySettings(
    id: string,
    client: WhatsAppClientPort,
    settings: SessionSettings
  ): Promise<void> {
    for (const [key, method] of SETTING_CALLS) {
      const flag = settings[key]
      if (flag === undefined) continue
      try {
        await withTimeout(client[method](flag), CALL_TIMEOUT_MS, method)
      } catch (error: unknown) {
        this.logger.warn(`[${id}] Applying ${key} failed (${errorKind(error)})`)
      }
    }
  }

  // ---- Boot ------------------------------------------------------------------------------------

  // Loads every status, then starts, one after another, the sessions that were linked and meant to
  // run. The gap between starts keeps the browsers from launching together.
  private async restore(): Promise<void> {
    const rows = await this.sessions.list()
    for (const row of rows) if (!this.statuses.has(row.id)) this.statuses.set(row.id, row.status)
    this.refreshGauge()
    const toStart = rows.filter(row => row.autoStart && row.linkedAt)
    await this.settleStaleStatuses(rows.filter(row => !toStart.includes(row)))
    for (const [index, row] of toStart.entries()) {
      if (index > 0) await this.waitStagger()
      if (this.shuttingDown) return
      try {
        await this.start(row.id)
      } catch (error: unknown) {
        this.logger.error(`[${row.id}] Restoring failed (${errorKind(error)})`)
      }
    }
  }

  // A row that says `ready` after a crash is wrong: nothing runs for it
  private async settleStaleStatuses(rows: Session[]): Promise<void> {
    for (const row of rows) {
      if (STATUSES_WITHOUT_CLIENT.includes(row.status)) continue
      await this.exclusive(row.id, () =>
        // A start may have come in between the read of the rows and this turn of the queue
        this.runtimes.has(row.id)
          ? Promise.resolve()
          : this.transition(row.id, 'stopped', {}, 'gateway restarted')
      )
    }
  }

  private waitStagger(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.wakeRestore = resolve
      this.restoreTimer = setTimeout(resolve, this.config.SESSION_START_STAGGER_MS)
    })
  }

  // ---- State -----------------------------------------------------------------------------------

  // Writes the status, then tells the consumers; a failure of either is logged and never undoes
  // the move, since the client has already made it. Nothing happens when nothing changed.
  private async transition(
    id: string,
    status: SessionStatus,
    patch: SessionPatch,
    reason?: string
  ): Promise<void> {
    const previous = this.statuses.get(id)
    if (previous === status && Object.keys(patch).length === 0) return
    try {
      await withTimeout(
        this.sessions.update(id, { ...patch, status }),
        DB_TIMEOUT_MS,
        'session update'
      )
    } catch (error: unknown) {
      this.logger.error(`[${id}] Saving the status ${status} failed (${errorKind(error)})`)
    }
    this.setKnownStatus(id, status)
    if (previous === undefined || previous === status) return
    try {
      await this.pipeline.publish(id, 'session_status', {
        status,
        previous,
        ...(reason === undefined ? {} : { reason })
      })
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Publishing session_status failed (${errorKind(error)})`)
    }
  }

  private setKnownStatus(id: string, status: SessionStatus): void {
    this.statuses.set(id, status)
    this.refreshGauge()
  }

  private refreshGauge(): void {
    const counts = new Map<SessionStatus, number>(SESSION_STATUSES.map(status => [status, 0]))
    for (const status of this.statuses.values()) counts.set(status, (counts.get(status) ?? 0) + 1)
    for (const [status, count] of counts) this.metrics.metrics.sessions.set({ status }, count)
  }

  private newRuntime(id: string, pairingPhoneNumber: string | undefined): Runtime {
    const runtime: Runtime = {
      client: undefined,
      generation: 0,
      phaseStartedAt: undefined,
      qr: undefined,
      pairingPhoneNumber,
      reconnectAttempts: 0,
      reconnectTimer: undefined,
      unsubscribe: undefined
    }
    this.runtimes.set(id, runtime)
    return runtime
  }

  // Half of the ceiling plus a random share of the other half: a session that keeps failing never
  // retries at once, and sessions that dropped together do not come back together
  private reconnectDelayMs(attempt: number): number {
    const ceiling = backoffCeilingMs(attempt, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS)
    return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2))
  }

  private assertCapacity(id: string): void {
    if (!this.runtimes.has(id) && this.runtimes.size >= this.config.MAX_SESSIONS) {
      throw new ConflictError(
        'MAX_SESSIONS_REACHED',
        `The gateway already runs ${this.config.MAX_SESSIONS} sessions`
      )
    }
  }

  private async requireRow(id: string): Promise<Session> {
    const session = await this.sessions.findById(id)
    if (!session) throw new NotFoundError('NOT_FOUND', `Session ${id} does not exist`)
    // A command can come before the boot has loaded the statuses
    if (!this.statuses.has(id)) this.setKnownStatus(id, session.status)
    return session
  }

  // Runs `task` after everything queued before it for the same session. A failing task rejects its
  // own caller and never the ones behind it.
  private exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(id) ?? Promise.resolve()).then(task)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(id, tail)
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id)
    })
    return result
  }

  // For work nobody awaits: a failure is logged, never left as an unhandled rejection
  private run(id: string, what: string, task: () => Promise<void>): void {
    this.exclusive(id, task).catch((error: unknown) => {
      this.logger.error(`[${id}] ${what} failed (${errorKind(error)})`)
    })
  }

  // Removes `seq:<id>` and `dedupe:<id>:*`, so a session created again under the same id starts clean
  private async deleteRedisKeys(id: string): Promise<void> {
    try {
      const client = this.redis.client
      const keys = [`seq:${id}`]
      let cursor = '0'
      do {
        const [next, found] = await withTimeout(
          client.scan(cursor, 'MATCH', `dedupe:${id}:*`, 'COUNT', SCAN_COUNT),
          REDIS_TIMEOUT_MS,
          'redis scan'
        )
        cursor = next
        keys.push(...found)
      } while (cursor !== '0')
      await withTimeout(client.del(...keys), REDIS_TIMEOUT_MS, 'redis del')
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Deleting the Redis keys failed (${errorKind(error)})`)
    }
  }
}
