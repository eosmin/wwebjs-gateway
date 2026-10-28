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
      await Promise.all(
        runs.map(run =>
          this.inspect(run).catch((error: unknown) => {
            this.logger.error(`[${run.id}] Health check failed to run (${errorKind(error)})`)
          })
        )
      )
    } finally {
      this.checking = false
    }
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
