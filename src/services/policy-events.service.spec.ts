import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { EventPipelineService } from '../whatsapp/event-pipeline.service.js'

import { PolicyEventsService } from './policy-events.service.js'
import type { SendPolicyAdminService } from './send-policy-admin.service.js'
import type { DecisionEvent, ReachabilityChange, SendPolicyService } from './send-policy.service.js'

function setup() {
  const listeners = {
    decision: undefined as ((event: DecisionEvent) => void) | undefined,
    reach: undefined as ((change: ReachabilityChange) => void) | undefined
  }
  const stops = { decision: jest.fn(), reach: jest.fn() }
  const policy = {
    onDecision: jest.fn((fn: (event: DecisionEvent) => void) => {
      listeners.decision = fn
      return stops.decision
    }),
    onReachabilityChange: jest.fn((fn: (change: ReachabilityChange) => void) => {
      listeners.reach = fn
      return stops.reach
    }),
    handleIncoming: jest.fn((_s: string, _c: string, _t: string) => Promise.resolve(false))
  }
  const admin = { refreshGauge: jest.fn(() => Promise.resolve()) }
  const stopIncoming = jest.fn()
  const hook: { current?: (s: string, c: string, t: string) => Promise<boolean> } = {}
  const pipeline = {
    publish: jest.fn(() => Promise.resolve()),
    setIncomingPolicy: jest.fn((fn: (s: string, c: string, t: string) => Promise<boolean>) => {
      hook.current = fn
      return stopIncoming
    })
  }
  const metrics = new MetricsService()
  const service = new PolicyEventsService(
    policy as unknown as SendPolicyService,
    admin as unknown as SendPolicyAdminService,
    pipeline as unknown as EventPipelineService,
    metrics
  )
  service.onModuleInit()
  return { service, listeners, stops, stopIncoming, hook, policy, admin, pipeline, metrics }
}

describe('PolicyEventsService', () => {
  it('counts each decision by rule and records how long a delay is', async () => {
    const { listeners, metrics } = setup()

    listeners.decision?.({ stage: 'dispatch', decision: { decision: 'allow' } })
    listeners.decision?.({
      stage: 'dispatch',
      decision: { decision: 'delay', delayMs: 2000, rule: 'session_per_minute' }
    })
    listeners.decision?.({
      stage: 'enqueue',
      decision: { decision: 'reject', code: 'RECIPIENT_SUPPRESSED', rule: 'suppressed' }
    })

    const text = await metrics.scrape()
    expect(text).toContain('gw_policy_decisions_total{rule="none",decision="allow"} 1')
    expect(text).toContain(
      'gw_policy_decisions_total{rule="session_per_minute",decision="delay"} 1'
    )
    expect(text).toContain('gw_policy_decisions_total{rule="suppressed",decision="reject"} 1')
    expect(text).toContain('gw_policy_delay_seconds_count 1')
    expect(text).toContain('gw_policy_delay_seconds_sum 2')
  })

  it('publishes chat_unreachable when the flag changes', () => {
    const { listeners, pipeline } = setup()

    listeners.reach?.({ sessionId: 's1', chatId: 'a@c.us', unreachable: true })

    expect(pipeline.publish).toHaveBeenCalledWith('s1', 'chat_unreachable', {
      chatId: 'a@c.us',
      unreachable: true
    })
  })

  it('survives a publish that fails', async () => {
    const { listeners, pipeline } = setup()
    pipeline.publish.mockRejectedValue(new Error('redis down'))

    expect(() =>
      listeners.reach?.({ sessionId: 's1', chatId: 'a@c.us', unreachable: false })
    ).not.toThrow()
    await Promise.resolve()
  })

  it('gives the pipeline the policy for incoming messages and refreshes the gauge on an opt-out', async () => {
    const { hook, policy, admin } = setup()
    admin.refreshGauge.mockClear()

    policy.handleIncoming.mockResolvedValueOnce(false)
    expect(await hook.current?.('s1', 'a@c.us', 'hola')).toBe(false)
    expect(admin.refreshGauge).not.toHaveBeenCalled()

    policy.handleIncoming.mockResolvedValueOnce(true)
    expect(await hook.current?.('s1', 'a@c.us', 'stop')).toBe(true)
    expect(policy.handleIncoming).toHaveBeenLastCalledWith('s1', 'a@c.us', 'stop')
    expect(admin.refreshGauge).toHaveBeenCalledTimes(1)
  })

  it('passes a policy failure on to the pipeline, which retries it', async () => {
    const { hook, policy } = setup()
    policy.handleIncoming.mockRejectedValueOnce(new Error('redis down'))

    await expect(hook.current?.('s1', 'a@c.us', 'stop')).rejects.toThrow('redis down')
  })

  it('fills the gauge at start and lets go of the policy at shutdown', () => {
    const { service, admin, stops, stopIncoming } = setup()

    expect(admin.refreshGauge).toHaveBeenCalledTimes(1)
    service.onModuleDestroy()
    expect(stops.decision).toHaveBeenCalledTimes(1)
    expect(stops.reach).toHaveBeenCalledTimes(1)
    expect(stopIncoming).toHaveBeenCalledTimes(1)
  })
})
