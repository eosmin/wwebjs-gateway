import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap
} from '@nestjs/common'

import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'

import { SessionManager, type RunningSession } from './session-manager.service.js'

const STATE_TIMEOUT_MS = 10_000
const MEMORY_TIMEOUT_MS = 5000
const BYTES_PER_MB = 1024 * 1024
// After a restart for memory the guard waits this long before it can act again: a gateway that is
// big on its own would otherwise restart one session after another
const MEMORY_RESTART_COOLDOWN_MS = 10 * 60_000
const HEALTHY_STATE = 'CONNECTED'
// A blocking state must be read this many checks in a row before the session is failed: failing
// ends the retries, so one transient answer (a phone that is briefly offline) must not do it
const BLOCKING_CONFIRMATIONS = 2
// What `getState()` is known to answer; anything else is logged as unknown, since it comes from the page
const KNOWN_STATES: ReadonlySet<string> = new Set([
  'CONNECTED',
  'OPENING',
  'PAIRING',
  'TIMEOUT',
  'UNLAUNCHED',
  'CONFLICT',
  'UNPAIRED',
  'UNPAIRED_IDLE',
  'DEPRECATED_VERSION',
  'TOS_BLOCK',
  'PROXYBLOCK'
])
// States a new browser does not fix: WhatsApp refuses the account, the link is gone or the build is
// too old. CONFLICT is one only while the takeover is off.
const BLOCKING_STATES: ReadonlySet<string> = new Set([
  'CONFLICT',
  'UNPAIRED',
  'UNPAIRED_IDLE',
  'DEPRECATED_VERSION',
  'TOS_BLOCK',
  'PROXYBLOCK'
])

interface FailureCount {
  generation: number
  count: number
}

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error)

// Looks at every running session on a timer (TDD §6.5): a session stuck while it starts is
// reconnected, a ready one that stops answering is reconnected after WATCHDOG_MAX_FAILURES checks,
// and one in a blocking state is failed after BLOCKING_CONFIRMATIONS checks in a row. It only reads the state of a client; what has to
// change goes through the manager, which ignores a request about a run that has moved on. A request
// is not awaited by the pass: a session whose teardown is slow must not delay the checks of the rest.
@Injectable()
export class WatchdogService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WatchdogService.name)
  private readonly failures = new Map<string, FailureCount>()
  private readonly blocked = new Map<string, FailureCount>()
  // Sessions with a request in flight: one at a time, so a busy queue does not collect copies
  private readonly pending = new Set<string>()
  // Answers true for a session that must not be restarted now (it is sending)
  private readonly busyChecks = new Set<(sessionId: string) => boolean>()
  private readonly unreadableMemory = new Set<string>()
  private lastMemoryRestartAt = Number.NEGATIVE_INFINITY
  private timer: NodeJS.Timeout | undefined
  private checking = false

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionManager) private readonly manager: SessionManager
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.check()
    }, this.config.WATCHDOG_INTERVAL_MS)
    this.timer.unref()
  }

  beforeApplicationShutdown(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  // The send queue registers here: the memory guard never restarts a session in the middle of a send
  addBusyCheck(check: (sessionId: string) => boolean): void {
    this.busyChecks.add(check)
  }

  // One pass over every session. A pass that finds the previous one still running does nothing, so
  // a slow browser cannot pile up checks.
  async check(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const runs = this.manager.running()
      const ids = new Set(runs.map(run => run.id))
      for (const counts of [this.failures, this.blocked]) {
        for (const id of counts.keys()) if (!ids.has(id)) counts.delete(id)
      }
      for (const id of this.unreadableMemory) if (!ids.has(id)) this.unreadableMemory.delete(id)
      await Promise.all(
        runs.map(run =>
          this.inspect(run).catch((error: unknown) => {
            this.logger.error(`[${run.id}] Health check failed to run (${errorKind(error)})`)
          })
        )
      )
      await this.guardMemory(runs).catch((error: unknown) => {
        this.logger.error(`Memory guard failed to run (${errorKind(error)})`)
      })
    } finally {
      this.checking = false
    }
  }

  // MEMORY_RESTART_THRESHOLD_MB counts the gateway process and the browsers of its sessions (each
  // Chromium is a process of its own, so the gateway alone would never show the growth). Over the
  // limit, the ready session with the biggest browser that is not sending is restarted.
  private async guardMemory(runs: RunningSession[]): Promise<void> {
    const limit = this.config.MEMORY_RESTART_THRESHOLD_MB * BYTES_PER_MB
    if (limit === 0 || Date.now() - this.lastMemoryRestartAt < MEMORY_RESTART_COOLDOWN_MS) return
    const sizes = await Promise.all(
      runs.map(async run => ({ run, bytes: await this.readMemory(run) }))
    )
    const own = process.memoryUsage().rss
    const total = sizes.reduce((sum, { bytes }) => sum + (bytes ?? 0), own)
    if (total <= limit) return
    // Restarting a browser cannot lower what the gateway itself holds, and it would only cycle the sessions
    if (own > limit) {
      this.logger.warn(
        `The gateway process alone uses ${Math.round(own / BYTES_PER_MB)} MB, over the limit: no session is restarted for it`
      )
      return
    }

    const candidates = sizes.filter(
      ({ run, bytes }) => run.status === 'ready' && bytes !== undefined && !this.isBusy(run.id)
    )
    const largest = candidates.reduce<(typeof candidates)[number] | undefined>(
      (best, entry) => ((entry.bytes ?? 0) > (best?.bytes ?? -1) ? entry : best),
      undefined
    )
    const totalMb = Math.round(total / BYTES_PER_MB)
    if (!largest) {
      this.logger.warn(
        `Memory is ${totalMb} MB, over the limit, and no idle session can be restarted`
      )
      return
    }
    const sessionMb = Math.round((largest.bytes ?? 0) / BYTES_PER_MB)
    this.request(largest.run, () => {
      // The restart waits in the queue of the session: a send may have started since it was chosen
      if (this.isBusy(largest.run.id)) return Promise.resolve()
      // The cooldown starts when a restart is really asked for, not when a session was chosen
      this.lastMemoryRestartAt = Date.now()
      this.logger.warn(
        `[${largest.run.id}] Memory is ${totalMb} MB, over the limit: restarting the largest idle session (${sessionMb} MB)`
      )
      return this.manager.reconnectRun(
        largest.run,
        'WATCHDOG_MEMORY',
        `memory ${totalMb} MB over MEMORY_RESTART_THRESHOLD_MB`
      )
    })
  }

  private isBusy(sessionId: string): boolean {
    for (const check of this.busyChecks) if (check(sessionId)) return true
    return false
  }

  private async readMemory(run: RunningSession): Promise<number | undefined> {
    let bytes: number | undefined
    try {
      bytes = await withTimeout(run.client.getBrowserMemoryBytes(), MEMORY_TIMEOUT_MS, 'memory')
    } catch {
      bytes = undefined
    }
    // Without it the guard is blind to this session, which is worth knowing once per outage
    if (bytes !== undefined) {
      this.unreadableMemory.delete(run.id)
    } else if (!this.unreadableMemory.has(run.id)) {
      this.unreadableMemory.add(run.id)
      this.logger.warn(`[${run.id}] The memory guard cannot read the memory of the browser`)
    }
    return bytes
  }

  private async inspect(run: RunningSession): Promise<void> {
    if (run.status === 'ready') {
      await this.probe(run)
      return
    }
    this.forget(run.id)
    if (run.status === 'starting' || run.status === 'authenticating') this.checkStartup(run)
  }

  private checkStartup(run: RunningSession): void {
    if (run.phaseStartedAt === undefined) return
    const elapsedMs = Date.now() - run.phaseStartedAt
    if (elapsedMs <= this.config.SESSION_START_TIMEOUT_MS) return
    this.logger.warn(`[${run.id}] Stuck in ${run.status} for ${Math.round(elapsedMs / 1000)} s`)
    this.request(run, () =>
      this.manager.reconnectRun(
        run,
        'WATCHDOG_START_TIMEOUT',
        `stuck in ${run.status} for over ${elapsedMs} ms`
      )
    )
  }

  private async probe(run: RunningSession): Promise<void> {
    const state = await this.readState(run)
    if (state !== null && this.isBlocking(state)) {
      this.failures.delete(run.id)
      const seen = this.bump(this.blocked, run)
      if (seen < BLOCKING_CONFIRMATIONS) {
        this.logger.warn(
          `[${run.id}] WhatsApp Web is in ${state} (${seen}/${BLOCKING_CONFIRMATIONS})`
        )
        return
      }
      this.blocked.delete(run.id)
      this.logger.error(`[${run.id}] WhatsApp Web is in ${state}; the session is failed`)
      this.request(run, () =>
        this.manager.failRun(run, 'WATCHDOG_BLOCKED_STATE', `WhatsApp Web state ${state}`)
      )
      return
    }
    this.blocked.delete(run.id)
    if (state === HEALTHY_STATE) {
      this.failures.delete(run.id)
      return
    }
    const count = this.bump(this.failures, run)
    this.logger.warn(
      `[${run.id}] Health check ${count}/${this.config.WATCHDOG_MAX_FAILURES} failed (${this.describe(state)})`
    )
    if (count < this.config.WATCHDOG_MAX_FAILURES) return
    this.failures.delete(run.id)
    this.request(run, () =>
      this.manager.reconnectRun(run, 'WATCHDOG_HEALTH_CHECK', `health check failed ${count} times`)
    )
  }

  // Never awaited, never left as an unhandled rejection; a throw before the first await counts as
  // a rejection. A session with a request still in flight gets no second one.
  private request(run: RunningSession, task: () => Promise<void>): void {
    if (this.pending.has(run.id)) return
    this.pending.add(run.id)
    new Promise<void>(resolve => {
      resolve(task())
    })
      .catch((error: unknown) => {
        this.logger.error(`[${run.id}] Watchdog request failed (${errorKind(error)})`)
      })
      .finally(() => {
        this.pending.delete(run.id)
      })
  }

  private describe(state: string | null): string {
    if (state === null) return 'no answer'
    return KNOWN_STATES.has(state) ? state : 'unknown state'
  }

  // A call that fails or hangs is the same as no answer
  private async readState(run: RunningSession): Promise<string | null> {
    try {
      return await withTimeout(run.client.getState(), STATE_TIMEOUT_MS, 'getState')
    } catch {
      return null
    }
  }

  private isBlocking(state: string): boolean {
    if (state === 'CONFLICT' && this.config.TAKEOVER_ON_CONFLICT) return false
    return BLOCKING_STATES.has(state)
  }

  // The count belongs to one run: a session that came back in between starts from zero
  private bump(counts: Map<string, FailureCount>, run: RunningSession): number {
    const known = counts.get(run.id)
    const count = known?.generation === run.generation ? known.count + 1 : 1
    counts.set(run.id, { generation: run.generation, count })
    return count
  }

  private forget(id: string): void {
    this.failures.delete(id)
    this.blocked.delete(id)
  }
}
