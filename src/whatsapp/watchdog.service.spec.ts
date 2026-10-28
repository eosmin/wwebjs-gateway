import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { FakeWhatsAppClient } from '../../tests/helpers/fake-whatsapp-client.js'
import { parseEnv } from '../config/env.schema.js'
import type { SessionStatus } from '../types/dto.js'

import type { RunningSession, SessionManager } from './session-manager.service.js'
import { WatchdogService } from './watchdog.service.js'

const NOW = new Date('2026-10-28T12:00:00.000Z')
const ID = 'support-line'

function buildRun(overrides: Partial<RunningSession> = {}): RunningSession {
  return {
    id: ID,
    status: 'ready',
    generation: 1,
    client: new FakeWhatsAppClient(ID),
    phaseStartedAt: undefined,
    ...overrides
  }
}

function build(env: Record<string, string> = {}, runs: RunningSession[] = [buildRun()]) {
  const manager = {
    running: jest.fn(() => runs),
    reconnectRun: jest.fn(() => Promise.resolve()),
    failRun: jest.fn(() => Promise.resolve())
  }
  const watchdog = new WatchdogService(
    parseEnv({ ...TEST_ENV, ...env }),
    manager as unknown as SessionManager
  )
  return { watchdog, manager, runs }
}

const stateOf = (run: RunningSession, state: string | null): void => {
  ;(run.client as FakeWhatsAppClient).script('getState', () => state)
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  jest.spyOn(Logger.prototype, 'warn').mockImplementation()
  jest.spyOn(Logger.prototype, 'error').mockImplementation()
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('WatchdogService stuck startup', () => {
  it.each<SessionStatus>(['starting', 'authenticating'])(
    'reconnects a session that stays in %s past SESSION_START_TIMEOUT_MS',
    async status => {
      const run = buildRun({ status, phaseStartedAt: NOW.getTime() - 180_001 })
      const { watchdog, manager } = build({}, [run])
      await watchdog.check()
      expect(manager.reconnectRun).toHaveBeenCalledWith(
        run,
        'WATCHDOG_START_TIMEOUT',
        expect.stringContaining(status)
      )
    }
  )

  it('leaves a session that is still inside the timeout', async () => {
    const run = buildRun({ status: 'starting', phaseStartedAt: NOW.getTime() - 180_000 })
    const { watchdog, manager } = build({}, [run])
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
  })

  it.each<SessionStatus>(['qr', 'pairing_code', 'disconnected'])(
    'never restarts a session that waits in %s',
    async status => {
      const run = buildRun({ status, phaseStartedAt: NOW.getTime() - 3_600_000 })
      const { watchdog, manager } = build({}, [run])
      await watchdog.check()
      expect(manager.reconnectRun).not.toHaveBeenCalled()
      expect(manager.failRun).not.toHaveBeenCalled()
    }
  )
})

describe('WatchdogService blocking states', () => {
  it.each(['UNPAIRED', 'UNPAIRED_IDLE', 'DEPRECATED_VERSION', 'TOS_BLOCK', 'PROXYBLOCK'])(
    'fails a ready session that is in %s at two checks in a row, without a reconnect',
    async state => {
      const run = buildRun()
      stateOf(run, state)
      const { watchdog, manager } = build({}, [run])
      await watchdog.check()
      expect(manager.failRun).not.toHaveBeenCalled()
      await watchdog.check()
      expect(manager.failRun).toHaveBeenCalledWith(
        run,
        'WATCHDOG_BLOCKED_STATE',
        `WhatsApp Web state ${state}`
      )
      expect(manager.reconnectRun).not.toHaveBeenCalled()
    }
  )

  it('fails a session in CONFLICT when the takeover is off', async () => {
    const run = buildRun()
    stateOf(run, 'CONFLICT')
    const { watchdog, manager } = build({}, [run])
    await watchdog.check()
    await watchdog.check()
    expect(manager.failRun).toHaveBeenCalledWith(
      run,
      'WATCHDOG_BLOCKED_STATE',
      'WhatsApp Web state CONFLICT'
    )
  })

  it('does not fail a session in CONFLICT when the takeover is on', async () => {
    const run = buildRun()
    stateOf(run, 'CONFLICT')
    const { watchdog, manager } = build({ TAKEOVER_ON_CONFLICT: 'true' }, [run])
    await watchdog.check()
    await watchdog.check()
    await watchdog.check()
    expect(manager.failRun).not.toHaveBeenCalled()
  })

  it('does not fail a session for one blocking answer between healthy ones', async () => {
    const run = buildRun()
    const { watchdog, manager } = build({}, [run])
    stateOf(run, 'PROXYBLOCK')
    await watchdog.check()
    stateOf(run, 'CONNECTED')
    await watchdog.check()
    stateOf(run, 'PROXYBLOCK')
    await watchdog.check()
    expect(manager.failRun).not.toHaveBeenCalled()
  })

  it('does not carry a blocking answer over to a new run of the same session', async () => {
    const run = buildRun()
    const { watchdog, manager, runs } = build({}, [run])
    stateOf(run, 'UNPAIRED')
    await watchdog.check()
    const next = buildRun({ generation: 2 })
    stateOf(next, 'UNPAIRED')
    runs[0] = next
    await watchdog.check()
    expect(manager.failRun).not.toHaveBeenCalled()
  })
})

describe('WatchdogService health checks', () => {
  it('reconnects after WATCHDOG_MAX_FAILURES consecutive failures, not before', async () => {
    const run = buildRun()
    stateOf(run, null)
    const { watchdog, manager } = build({}, [run])
    await watchdog.check()
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
    expect(manager.reconnectRun).toHaveBeenCalledWith(
      run,
      'WATCHDOG_HEALTH_CHECK',
      'health check failed 3 times'
    )
  })

  it('counts a call that throws and one that hangs as failures', async () => {
    const run = buildRun()
    const client = run.client as FakeWhatsAppClient
    const { watchdog, manager } = build({ WATCHDOG_MAX_FAILURES: '2' }, [run])
    client.script('getState', () => Promise.reject(new Error('page crashed')))
    await watchdog.check()
    client.script('getState', () => new Promise<string>(() => undefined))
    const second = watchdog.check()
    await jest.advanceTimersByTimeAsync(10_000)
    await second
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
  })

  it('starts over after an answer that is healthy', async () => {
    const run = buildRun()
    const { watchdog, manager } = build({}, [run])
    stateOf(run, null)
    await watchdog.check()
    await watchdog.check()
    stateOf(run, 'CONNECTED')
    await watchdog.check()
    stateOf(run, null)
    await watchdog.check()
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
  })

  it('does not carry failures over to a new run of the same session', async () => {
    const run = buildRun()
    const { watchdog, manager, runs } = build({}, [run])
    stateOf(run, null)
    await watchdog.check()
    await watchdog.check()
    const next = buildRun({ generation: 2 })
    stateOf(next, null)
    runs[0] = next
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
  })

  it('does not stack a pass on one that is still running', async () => {
    const run = buildRun()
    ;(run.client as FakeWhatsAppClient).script(
      'getState',
      () => new Promise<string>(() => undefined)
    )
    const { watchdog } = build({}, [run])
    const first = watchdog.check()
    await watchdog.check()
    expect((run.client as FakeWhatsAppClient).callsOf('getState')).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(10_000)
    await first
  })

  it('checks on the WATCHDOG_INTERVAL_MS timer until the shutdown', async () => {
    const run = buildRun()
    const { watchdog } = build({ WATCHDOG_INTERVAL_MS: '1000' }, [run])
    watchdog.onApplicationBootstrap()
    await jest.advanceTimersByTimeAsync(2000)
    expect((run.client as FakeWhatsAppClient).callsOf('getState')).toHaveLength(2)
    watchdog.beforeApplicationShutdown()
    await jest.advanceTimersByTimeAsync(5000)
    expect((run.client as FakeWhatsAppClient).callsOf('getState')).toHaveLength(2)
  })
})

describe('WatchdogService edge cases', () => {
  it.each(['OPENING', 'TIMEOUT', 'UNLAUNCHED'])(
    'counts %s as a failed check, not as a healthy one',
    async state => {
      const run = buildRun()
      stateOf(run, state)
      const { watchdog, manager } = build({}, [run])
      await watchdog.check()
      await watchdog.check()
      expect(manager.reconnectRun).not.toHaveBeenCalled()
      await watchdog.check()
      expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
    }
  )

  it('reconnects at the first failed check when WATCHDOG_MAX_FAILURES is 1', async () => {
    const run = buildRun()
    stateOf(run, null)
    const { watchdog, manager } = build({ WATCHDOG_MAX_FAILURES: '1' }, [run])
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
  })

  it('counts again from zero after asking for a reconnect', async () => {
    const run = buildRun()
    stateOf(run, null)
    const { watchdog, manager } = build({}, [run])
    for (let n = 0; n < 5; n++) await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(2)
  })

  it('counts again from zero when the session left ready and came back with the same run', async () => {
    const run = buildRun()
    stateOf(run, null)
    const { watchdog, manager, runs } = build({}, [run])
    await watchdog.check()
    await watchdog.check()
    runs[0] = { ...run, status: 'qr' }
    await watchdog.check()
    runs[0] = run
    await watchdog.check()
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
  })

  it('counts again from zero after a session left the list and came back', async () => {
    const run = buildRun()
    stateOf(run, null)
    const { watchdog, manager, runs } = build({}, [run])
    await watchdog.check()
    await watchdog.check()
    runs.length = 0
    await watchdog.check()
    runs.push(run)
    await watchdog.check()
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
  })

  it('a blocking state wipes the count of failed checks', async () => {
    const run = buildRun()
    const { watchdog, manager } = build({}, [run])
    stateOf(run, null)
    await watchdog.check()
    await watchdog.check()
    stateOf(run, 'TOS_BLOCK')
    await watchdog.check()
    stateOf(run, null)
    await watchdog.check()
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
  })

  it('takes a getState that answers just inside the limit as an answer', async () => {
    const run = buildRun()
    ;(run.client as FakeWhatsAppClient).script(
      'getState',
      () => new Promise<string>(resolve => setTimeout(() => resolve('CONNECTED'), 9_999))
    )
    const { watchdog, manager } = build({ WATCHDOG_MAX_FAILURES: '1' }, [run])
    const pass = watchdog.check()
    await jest.advanceTimersByTimeAsync(9_999)
    await pass
    expect(manager.reconnectRun).not.toHaveBeenCalled()
  })

  it('uses SESSION_START_TIMEOUT_MS from the config', async () => {
    const run = buildRun({ status: 'starting', phaseStartedAt: NOW.getTime() - 5_001 })
    const { watchdog, manager } = build({ SESSION_START_TIMEOUT_MS: '5000' }, [run])
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
  })

  it('leaves a starting session without a phase start, and the statuses with no client', async () => {
    const runs = [
      buildRun({ id: 'a', status: 'starting', phaseStartedAt: undefined }),
      buildRun({ id: 'b', status: 'failed', phaseStartedAt: 0 }),
      buildRun({ id: 'c', status: 'stopped', phaseStartedAt: 0 })
    ]
    const { watchdog, manager } = build({}, runs)
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
    expect(manager.failRun).not.toHaveBeenCalled()
  })

  it('logs a request that fails by its kind only, and still checks the other sessions', async () => {
    const a = buildRun({ id: 'a' })
    const b = buildRun({ id: 'b' })
    stateOf(a, 'TOS_BLOCK')
    stateOf(b, 'UNPAIRED')
    const { watchdog, manager } = build({}, [a, b])
    manager.failRun.mockImplementationOnce(() => Promise.reject(new Error('secret detail')))
    const error = jest.spyOn(Logger.prototype, 'error')
    await watchdog.check()
    await watchdog.check()
    await jest.advanceTimersByTimeAsync(0)
    expect(manager.failRun).toHaveBeenCalledTimes(2)
    const lines = error.mock.calls.map(call => String(call[0]))
    expect(lines.some(line => line.includes('Watchdog request failed (Error)'))).toBe(true)
    expect(lines.join('\n')).not.toContain('secret detail')
  })

  it('does not wait for a request that takes long, and does not stack a second one', async () => {
    const run = buildRun({ status: 'starting', phaseStartedAt: NOW.getTime() - 200_000 })
    const { watchdog, manager } = build({}, [run])
    let finish: () => void = () => undefined
    manager.reconnectRun.mockImplementationOnce(
      () => new Promise<void>(resolve => (finish = resolve))
    )
    await watchdog.check()
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)

    finish()
    await jest.advanceTimersByTimeAsync(0)
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(2)
  })

  it('keeps checking after the list of sessions threw once', async () => {
    const run = buildRun()
    const { watchdog, manager } = build({ WATCHDOG_MAX_FAILURES: '1' }, [run])
    stateOf(run, null)
    manager.running.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await expect(watchdog.check()).rejects.toThrow('boom')
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
  })

  it('logs a state it does not know as unknown', async () => {
    const run = buildRun()
    stateOf(run, 'x'.repeat(500))
    const { watchdog } = build({}, [run])
    const warn = jest.spyOn(Logger.prototype, 'warn')
    await watchdog.check()
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('unknown state')
    expect(line).not.toContain('xxxx')
  })
})

describe('WatchdogService blocking state bookkeeping', () => {
  it('counts again from zero after the session failed, and does not ask twice', async () => {
    const run = buildRun()
    stateOf(run, 'TOS_BLOCK')
    const { watchdog, manager } = build({}, [run])
    await watchdog.check()
    await watchdog.check()
    expect(manager.failRun).toHaveBeenCalledTimes(1)
    await watchdog.check()
    expect(manager.failRun).toHaveBeenCalledTimes(1)
    await watchdog.check()
    expect(manager.failRun).toHaveBeenCalledTimes(2)
  })

  it('an answer that is not blocking and not healthy wipes the blocking count', async () => {
    const run = buildRun()
    const { watchdog, manager } = build({}, [run])
    stateOf(run, 'PROXYBLOCK')
    await watchdog.check()
    stateOf(run, null)
    await watchdog.check()
    stateOf(run, 'PROXYBLOCK')
    await watchdog.check()
    expect(manager.failRun).not.toHaveBeenCalled()
  })

  it('forgets a blocking answer when the session left ready, or left the list', async () => {
    const run = buildRun()
    stateOf(run, 'UNPAIRED')
    const { watchdog, manager, runs } = build({}, [run])
    await watchdog.check()
    runs[0] = { ...run, status: 'qr' }
    await watchdog.check()
    runs[0] = run
    await watchdog.check()
    expect(manager.failRun).not.toHaveBeenCalled()

    runs.length = 0
    await watchdog.check()
    runs.push(run)
    await watchdog.check()
    expect(manager.failRun).not.toHaveBeenCalled()
  })

  it('keeps the counts of two sessions apart', async () => {
    const a = buildRun({ id: 'a' })
    const b = buildRun({ id: 'b' })
    stateOf(a, 'TOS_BLOCK')
    stateOf(b, 'CONNECTED')
    const { watchdog, manager } = build({}, [a, b])
    await watchdog.check()
    stateOf(b, 'TOS_BLOCK')
    await watchdog.check()
    expect(manager.failRun).toHaveBeenCalledTimes(1)
    expect(manager.failRun).toHaveBeenCalledWith(a, 'WATCHDOG_BLOCKED_STATE', expect.any(String))
    await watchdog.check()
    expect(manager.failRun).toHaveBeenCalledWith(b, 'WATCHDOG_BLOCKED_STATE', expect.any(String))
  })

  it('treats CONFLICT with the takeover on as a failed check that ends in a reconnect', async () => {
    const run = buildRun()
    stateOf(run, 'CONFLICT')
    const { watchdog, manager } = build({ TAKEOVER_ON_CONFLICT: 'true' }, [run])
    await watchdog.check()
    await watchdog.check()
    expect(manager.reconnectRun).not.toHaveBeenCalled()
    await watchdog.check()
    expect(manager.reconnectRun).toHaveBeenCalledTimes(1)
    expect(manager.failRun).not.toHaveBeenCalled()
  })

  it('logs a request that throws before it returns, and goes on', async () => {
    const a = buildRun({ id: 'a', status: 'starting', phaseStartedAt: NOW.getTime() - 200_000 })
    const b = buildRun({ id: 'b', status: 'starting', phaseStartedAt: NOW.getTime() - 200_000 })
    const { watchdog, manager } = build({}, [a, b])
    manager.reconnectRun.mockImplementationOnce(() => {
      throw new Error('sync boom')
    })
    const error = jest.spyOn(Logger.prototype, 'error')
    await watchdog.check()
    await jest.advanceTimersByTimeAsync(0)
    expect(manager.reconnectRun).toHaveBeenCalledTimes(2)
    expect(error.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('sync boom')
  })
})
