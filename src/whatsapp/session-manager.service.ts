import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap
} from '@nestjs/common'
import { z } from 'zod'

import { ConflictError, InternalError, NotFoundError } from '../common/errors.js'
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

import { ACCOUNT_SETTING_CALLS } from './account-settings.js'
import { EventPipelineService } from './event-pipeline.service.js'
import {
  DAY_MS,
  hasSavedLogin,
  isSessionId,
  purgeExpiredQuarantine,
  quarantineSavedLogin,
  restoreSavedLogin,
  wasQuarantinedWithin
} from './saved-login.js'
import { WaAuthStalledError, WaProfileLockedError } from './wa-errors.js'
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
// How long a browser on a clean profile gets to show a QR code
const PROBE_TIMEOUT_MS = 60_000
// A login is moved aside by the gateway on its own once per session in this time; the next one needs a
// person
const AUTO_QUARANTINE_WINDOW_MS = DAY_MS
const AUTH_QUARANTINED = 'AUTH_QUARANTINED'
const LOGIN_NOT_MOVED_MESSAGE =
  'the account was forgotten but the saved login could not be moved to quarantine and is still in the data folder; move or delete WWEBJS_DATA_PATH/session-<id> by hand before starting the session'
type QuarantineOutcome =
  | { kind: 'moved' }
  | { kind: 'shutdown' }
  // The probe reached the QR code and one more start with the saved login is on its way
  | { kind: 'retrying' }
  | { kind: 'kept'; why: string }
const kept = (why: string): QuarantineOutcome => ({ kind: 'kept', why })

// A session that is no longer linked to an account, and does not start on its own
const FORGOTTEN_ACCOUNT: SessionPatch = {
  autoStart: false,
  phoneNumber: null,
  pushName: null,
  linkedAt: null,
  lastError: null
}
const QUARANTINED_MESSAGE =
  'the saved login was rejected by WhatsApp (the account was probably unlinked from the phone while the gateway was stopped); it was moved to quarantine, not deleted; start the session and scan the QR code'

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
  // Browser starts that failed one after another; any sign of life (QR, code, login) clears it
  initializeFailures: number
  // Of those, the ones in a row that were a page that loaded and a connection that never opened
  authStalls: number
  // A browser on a clean profile reached the QR code, and the saved login got one more start: if that
  // one stalls too the login is moved aside, and any sign of life clears the mark
  probeReachedQr: boolean
  reconnectTimer: NodeJS.Timeout | undefined
  unsubscribe: (() => void) | undefined
  // When the session last became ready; only the log of a disconnect reads it
  readyAt: number | undefined
}

// The codes the adapter reports when its browser or page is gone; any other stays one label
const BROWSER_RECOVERY_CODES: ReadonlySet<string> = new Set([
  'BROWSER_DISCONNECTED',
  'PAGE_CLOSED',
  'PAGE_CRASHED'
])

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
  // Ends each probe browser that waits for a QR code (as "no"), so a shutdown does not wait for them;
  // several sessions can probe at the same time
  private readonly probeAborters = new Set<() => void>()
  private restoreTimer: NodeJS.Timeout | undefined
  private wakeRestore: (() => void) | undefined
  // The read of every session row into `statuses`, shared by the boot and `whenLoaded`; cleared on a
  // failure so the next caller reads again
  private loading: Promise<Session[]> | undefined

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
    for (const abort of [...this.probeAborters]) abort()
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
      const moved = await this.keepLoginOfRemoved(id, runtime !== undefined)
      try {
        await this.sessions.delete(id)
      } catch (error: unknown) {
        // The session stays, so its login goes back to where the next start looks for it
        await this.putLoginBack(id, moved)
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

  // The login of a deleted session must not stay where a session created again under the same id
  // would find it, nor stay for ever: it goes to quarantine (the owner deleted the session on purpose,
  // but a deletion by mistake stays recoverable for SESSION_AUTH_QUARANTINE_TTL_DAYS, and then the
  // purge deletes it). It runs before the row is deleted: a login that cannot be moved stops the
  // deletion (the error says why) instead of leaving the credentials of an account with no session.
  // A session that was logged out at WhatsApp has no folder left (the library deletes it).
  // Resolves to where the login went, undefined when there was none.
  private async keepLoginOfRemoved(id: string, hadClient: boolean): Promise<string | undefined> {
    if (!isSessionId(id)) return undefined
    try {
      return await quarantineSavedLogin(this.config.WWEBJS_DATA_PATH, id, new Date(), {
        removed: true
      })
    } catch (error: unknown) {
      this.logger.error(`[${id}] Moving the saved login to quarantine failed (${errorKind(error)})`)
      // `transition` never throws. The client is gone, so the status must say so; the session was
      // meant to go, so it does not come back at the next boot either
      await this.transition(id, hadClient ? 'stopped' : (this.statuses.get(id) ?? 'stopped'), {
        autoStart: false
      })
      throw new InternalError(
        'INTERNAL',
        'The session was not deleted: its saved login could not be moved to quarantine and is still in the data folder; move or delete WWEBJS_DATA_PATH/session-<id> by hand, then delete the session again'
      )
    }
  }

  // The row could not be deleted after the login was moved: the session goes on, so the login must
  // be where the session looks for it. A login that cannot be put back stays in quarantine, and the
  // log says where, so nobody has to find out.
  private async putLoginBack(id: string, moved: string | undefined): Promise<void> {
    if (moved === undefined) return
    try {
      if (!(await restoreSavedLogin(this.config.WWEBJS_DATA_PATH, id, moved))) {
        this.logger.error(`[${id}] The saved login stays in quarantine (${basename(moved)})`)
      }
    } catch (error: unknown) {
      this.logger.error(
        `[${id}] Putting the saved login back failed (${errorKind(error)}); it stays in quarantine (${basename(moved)})`
      )
    }
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

  // Resolves once the status of every session is loaded (it loads them itself when the boot has not
  // yet). Before that `status` answers NOT_FOUND for a session that exists, so whoever acts on a stored
  // session at boot (the send workers draining the jobs of the last run) waits for this first. Rejects
  // when the rows cannot be read; the next call reads again.
  async whenLoaded(): Promise<void> {
    await this.loadRows()
  }

  private loadRows(): Promise<Session[]> {
    this.loading ??= this.sessions
      .list()
      .then(rows => {
        for (const row of rows)
          if (!this.statuses.has(row.id)) this.statuses.set(row.id, row.status)
        this.refreshGauge()
        return rows
      })
      .catch((error: unknown) => {
        this.loading = undefined
        throw error
      })
    return this.loading
  }

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

  // The client of a session that waits for the account to be linked, which is where a pairing code
  // is asked for or cancelled: `requireReady` would refuse it, since nothing is logged in yet
  requireLinking(id: string, ...allowed: readonly SessionStatus[]): WhatsAppClientPort {
    const status = this.status(id)
    const client = this.runtimes.get(id)?.client
    if (!allowed.includes(status) || !client) {
      throw new ConflictError(
        'SESSION_NOT_READY',
        `Session ${id} is ${status}, not one of: ${allowed.join(', ')}`
      )
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
  private async announceError(
    id: string,
    code: WatchdogCode | typeof AUTH_QUARANTINED,
    message: string
  ): Promise<void> {
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
            ? this.initializeFailed(id, runtime, error)
            : Promise.resolve()
        )
      })
    } catch (error: unknown) {
      await this.reconnect(id, runtime, `start failed (${errorKind(error)})`)
    }
  }

  // A browser that does not start is retried like any drop, but only so many times in a row: what
  // makes it fail (a profile that cannot be used, a lock held by a foreign process, no Chrome) does not
  // go away by waiting, and a session that retries for ever hides it. The count restarts at any sign
  // that a browser did come up (a QR code, a pairing code, a login).
  private async initializeFailed(id: string, runtime: Runtime, error: unknown): Promise<void> {
    runtime.initializeFailures++
    runtime.authStalls = error instanceof WaAuthStalledError ? runtime.authStalls + 1 : 0
    // The message of our own lock error says what to do; any other text of a library stays out
    const detail = error instanceof WaProfileLockedError ? `: ${error.message}` : ''
    const reason = `initialize failed (${errorKind(error)})${detail}`
    const max = this.config.SESSION_INITIALIZE_MAX_ATTEMPTS
    if (runtime.initializeFailures >= max) {
      this.logger.error(`[${id}] The browser did not start ${max} times in a row; giving up`)
      // Every failure of the run was a login that never connected: maybe it is dead
      const outcome =
        runtime.authStalls >= max ? await this.quarantineStaleLogin(id, runtime) : undefined
      if (
        outcome?.kind === 'moved' ||
        outcome?.kind === 'shutdown' ||
        outcome?.kind === 'retrying'
      ) {
        return
      }
      const hint =
        outcome?.kind === 'kept'
          ? `; the saved login was kept (${outcome.why}); if the account was unlinked from the phone, log the session out to move it to quarantine`
          : ''
      await this.fail(
        id,
        runtime,
        `the browser did not start ${max} times in a row (last: ${reason}); check the browser, the data folder and the saved login, then start the session again${hint}`
      )
      return
    }
    await this.reconnect(id, runtime, reason)
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
    runtime.readyAt = undefined
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

  // A session that is ready is logged out at WhatsApp, and its login (dead now) is deleted. Any other
  // session has no connection to log out of: what the person asks is to forget the account, so the run
  // ends and the saved login goes to quarantine (a login that is dead cannot be told from one that is
  // not while the browser does not load, so it is never deleted here).
  private async unlink(id: string): Promise<Session> {
    const client = this.runtimes.get(id)?.client
    if (this.statuses.get(id) === 'ready' && client) {
      await withTimeout(client.logout(), CALL_TIMEOUT_MS, 'logout')
      return this.markLoggedOut(id, client)
    }
    const session = await this.halt(id, 'created', FORGOTTEN_ACCOUNT)
    try {
      await quarantineSavedLogin(this.config.WWEBJS_DATA_PATH, id)
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Moving the saved login to quarantine failed (${errorKind(error)})`)
      // The login is still where it was: the person is told, the next start would reuse it
      await this.transition(id, 'created', { lastError: LOGIN_NOT_MOVED_MESSAGE })
      return this.requireRow(id)
    }
    return session
  }

  // After SESSION_INITIALIZE_MAX_ATTEMPTS starts that all stalled on the login, in two steps. First a
  // browser on a clean profile: if it does not reach the QR code the browser, the network or WhatsApp
  // Web is at fault and the login stays. If it does, the login gets one more start (a stall that ended
  // with the network, or a WhatsApp that was down, would pass the probe and yet the login is fine).
  // Only when that start stalls too is the login what WhatsApp refuses: it goes to quarantine and the
  // session waits for a scan. A start that shows any sign of life ends it all (`signOfLife`).
  private async quarantineStaleLogin(id: string, runtime: Runtime): Promise<QuarantineOutcome> {
    const dataPath = this.config.WWEBJS_DATA_PATH
    try {
      const row = await this.sessions.findById(id)
      if (!row?.linkedAt) return kept('the session was never linked')
      if (!(await hasSavedLogin(dataPath, id))) return kept('there is no saved login')
      if (await wasQuarantinedWithin(dataPath, id, AUTO_QUARANTINE_WINDOW_MS)) {
        return kept('it was already moved to quarantine in the last 24 hours')
      }
      if (this.shuttingDown) return { kind: 'shutdown' }
      // The browser that failed goes first, then the probe gets the machine to itself
      await this.teardown(id, runtime)
      if (!runtime.probeReachedQr) {
        const reached = await this.reachesQr()
        if (this.shuttingDown) return { kind: 'shutdown' }
        if (!reached) {
          return kept(
            'a browser on a clean profile did not reach the QR code either, so the browser or WhatsApp Web is at fault'
          )
        }
        this.logger.warn(
          `[${id}] A browser on a clean profile reached the QR code; the saved login gets one more start`
        )
        runtime.probeReachedQr = true
        // One more start: if it fails again the run is at its cap at once
        runtime.initializeFailures = this.config.SESSION_INITIALIZE_MAX_ATTEMPTS - 1
        await this.launch(id, runtime, row)
        return { kind: 'retrying' }
      }
      if (this.shuttingDown) return { kind: 'shutdown' }
      await quarantineSavedLogin(dataPath, id)
      await this.purgeQuarantine()
    } catch (error: unknown) {
      this.logger.error(`[${id}] Quarantining the saved login failed (${errorKind(error)})`)
      return kept('it could not be moved')
    }
    this.logger.warn(`[${id}] The saved login was rejected by WhatsApp; moved to quarantine`)
    this.metrics.metrics.authQuarantined.inc()
    await this.announceError(id, AUTH_QUARANTINED, QUARANTINED_MESSAGE)
    await this.halt(id, 'created', { ...FORGOTTEN_ACCOUNT, lastError: QUARANTINED_MESSAGE })
    return { kind: 'moved' }
  }

  // Starts a browser on a throwaway profile (a session id of its own, nothing published, nothing kept)
  // and waits for the QR code. A failure of any kind is "no".
  private async reachesQr(): Promise<boolean> {
    if (this.shuttingDown) return false
    const probeId = `probe-${randomBytes(6).toString('hex')}`
    const client = this.createClient(probeId, {})
    let timer: NodeJS.Timeout | undefined
    let unsubscribe: (() => void) | undefined
    let abort: (() => void) | undefined
    try {
      return await new Promise<boolean>(resolve => {
        abort = () => {
          resolve(false)
        }
        this.probeAborters.add(abort)
        unsubscribe = client.onEvent(event => {
          if (event.event === 'qr') resolve(true)
        })
        timer = setTimeout(() => {
          resolve(false)
        }, PROBE_TIMEOUT_MS)
        client.initialize().then(
          () => undefined,
          () => {
            resolve(false)
          }
        )
      })
    } finally {
      if (abort) this.probeAborters.delete(abort)
      clearTimeout(timer)
      unsubscribe?.()
      try {
        await withTimeout(client.destroy(), CALL_TIMEOUT_MS, 'destroy')
      } catch (error: unknown) {
        this.logger.warn(`Destroying the probe browser failed (${errorKind(error)})`)
      }
      try {
        await withTimeout(client.discardAuth(), CALL_TIMEOUT_MS, 'discardAuth')
      } catch (error: unknown) {
        this.logger.warn(`Deleting the probe profile failed (${errorKind(error)})`)
      }
    }
  }

  // Deletes the logins that have been in quarantine for longer than SESSION_AUTH_QUARANTINE_TTL_DAYS
  private async purgeQuarantine(): Promise<void> {
    try {
      await purgeExpiredQuarantine(
        this.config.WWEBJS_DATA_PATH,
        this.config.SESSION_AUTH_QUARANTINE_TTL_DAYS * DAY_MS
      )
    } catch (error: unknown) {
      this.logger.warn(`Cleaning the quarantine failed (${errorKind(error)})`)
    }
  }

  private async logoutBestEffort(id: string, runtime: Runtime): Promise<void> {
    if (!runtime.client) return
    try {
      await withTimeout(runtime.client.logout(), CALL_TIMEOUT_MS, 'logout')
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Logout before the delete failed (${errorKind(error)})`)
    }
  }

  // Ends the run, then deletes the saved login with the client that ran it (it needs no browser, and
  // the browser must be gone first). A login that cannot be deleted is logged: the next start then
  // fails at the cap, with the reason in `lastError`.
  private async markLoggedOut(
    id: string,
    client: WhatsAppClientPort | undefined
  ): Promise<Session> {
    const session = await this.halt(id, 'created', FORGOTTEN_ACCOUNT)
    try {
      await withTimeout(client?.discardAuth() ?? Promise.resolve(), CALL_TIMEOUT_MS, 'discardAuth')
    } catch (error: unknown) {
      this.logger.warn(`[${id}] Deleting the saved login failed (${errorKind(error)})`)
    }
    return session
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
        this.signOfLife(runtime)
        runtime.qr = event.data.qr
        runtime.phaseStartedAt = undefined
        await this.transition(id, 'qr', { lastError: null })
        return
      case 'code':
        this.signOfLife(runtime)
        runtime.phaseStartedAt = undefined
        await this.transition(id, 'pairing_code', { lastError: null })
        return
      case 'authenticated':
        this.signOfLife(runtime)
        runtime.qr = undefined
        // The time a person took to scan the code is not the time the browser took to load
        runtime.phaseStartedAt = Date.now()
        await this.transition(id, 'authenticating', { lastError: null })
        return
      case 'ready':
        await this.onReady(id, runtime)
        return
      case 'auth_failure':
        await this.fail(id, runtime, 'auth failure')
        return
      case 'disconnected':
        // Before anything is done about it: a LOGOUT forgets the account, and the reason is the
        // only trace of why. Values that say nothing about the account.
        this.logger.warn(
          `[${id}] disconnected (reason=${event.data.reason.slice(0, 64)}, status=${this.statuses.get(id) ?? 'unknown'}, sinceReadyMs=${runtime.readyAt === undefined ? 'none' : Date.now() - runtime.readyAt})`
        )
        if (event.data.reason === 'LOGOUT') {
          // The login on disk is dead too: a browser started on it never reaches the QR code
          await this.markLoggedOut(id, runtime.client)
        } else {
          await this.reconnect(id, runtime, `disconnected (${event.data.reason})`)
        }
        return
      case 'session_error':
        // The watchdog's own session_error never comes through here, so this is the adapter finding
        // its browser or page gone: counted apart from the restarts the watchdog decides
        this.metrics.metrics.browserRecoveries.inc({
          code: BROWSER_RECOVERY_CODES.has(event.data.code) ? event.data.code : 'other'
        })
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

  // A browser did come up: whatever failed before it is not counted against the next start
  private signOfLife(runtime: Runtime): void {
    runtime.initializeFailures = 0
    runtime.authStalls = 0
    runtime.probeReachedQr = false
  }

  private async onReady(id: string, runtime: Runtime): Promise<void> {
    const client = runtime.client
    if (!client) return
    runtime.qr = undefined
    runtime.phaseStartedAt = undefined
    runtime.reconnectAttempts = 0
    runtime.readyAt = Date.now()
    this.signOfLife(runtime)
    const patch: SessionPatch = { lastConnectedAt: new Date(), lastError: null }
    try {
      const info = await withTimeout(client.getClientInfo(), CALL_TIMEOUT_MS, 'getClientInfo')
      patch.phoneNumber = info.wid.split('@')[0] ?? null
      // An account that has no push name keeps the one the row has
      if (info.pushname !== undefined) patch.pushName = info.pushname
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
    for (const [key, method] of ACCOUNT_SETTING_CALLS) {
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
    const rows = await this.loadRows()
    // Not awaited: cleaning old files must not delay the sessions
    void this.purgeQuarantine()
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
      initializeFailures: 0,
      authStalls: 0,
      probeReachedQr: false,
      reconnectTimer: undefined,
      unsubscribe: undefined,
      readyAt: undefined
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
