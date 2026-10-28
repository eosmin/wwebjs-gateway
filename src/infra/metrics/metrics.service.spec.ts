import { METRIC_DEFINITIONS } from './metric-definitions.js'
import { MetricsService } from './metrics.service.js'

describe('MetricsService', () => {
  it('registers every defined series, with its type and help', async () => {
    const body = await new MetricsService().scrape()

    for (const { name, type, help } of Object.values<{ name: string; type: string; help: string }>(
      METRIC_DEFINITIONS
    )) {
      expect(body).toContain(`# HELP ${name} ${help}`)
      expect(body).toContain(`# TYPE ${name} ${type}`)
    }
  })

  it('registers each series with the labels its definition names', () => {
    const { registry } = new MetricsService()

    for (const def of Object.values<{ name: string; labels: readonly string[] }>(
      METRIC_DEFINITIONS
    )) {
      const metric = registry.getSingleMetric(def.name) as unknown as { labelNames: string[] }
      expect(metric.labelNames).toEqual([...def.labels])
    }
  })

  it('takes every typed metric with its labels', async () => {
    const { metrics, scrape } = (() => {
      const service = new MetricsService()
      return { metrics: service.metrics, scrape: () => service.scrape() }
    })()

    metrics.sessions.set({ status: 'ready' }, 2)
    metrics.events.inc({ event: 'message' })
    metrics.orderingHeld.inc()
    metrics.orderingReordered.inc()
    metrics.orderingHoldSeconds.observe(1)
    metrics.pipelineErrors.inc({ stage: 'store' })
    metrics.sends.inc({ result: 'sent' })
    metrics.sendDurationSeconds.observe(0.2)
    metrics.sendQueueDepth.set({ session: 'main' }, 3)
    metrics.webhookDeliveries.inc({ result: 'success' })
    metrics.webhookDurationSeconds.observe(0.3)
    metrics.waCallDurationSeconds.observe({ op: 'sendMessage' }, 0.4)
    metrics.waCallErrors.inc({ op: 'sendMessage', type: 'timeout' })
    metrics.watchdogRestarts.inc()
    metrics.reconcileRecovered.inc()

    const body = await scrape()
    for (const line of [
      'gw_sessions{status="ready"} 2',
      'gw_events_total{event="message"} 1',
      'gw_ordering_held_total 1',
      'gw_ordering_reordered_total 1',
      'gw_ordering_hold_seconds_count 1',
      'gw_pipeline_errors_total{stage="store"} 1',
      'gw_send_total{result="sent"} 1',
      'gw_send_duration_seconds_count 1',
      'gw_send_queue_depth{session="main"} 3',
      'gw_webhook_deliveries_total{result="success"} 1',
      'gw_webhook_duration_seconds_count 1',
      'gw_wa_call_duration_seconds_count{op="sendMessage"} 1',
      'gw_wa_call_errors_total{op="sendMessage",type="timeout"} 1',
      'gw_watchdog_restarts_total 1',
      'gw_reconcile_recovered_total 1'
    ]) {
      expect(body).toContain(line)
    }
  })

  it('exposes the default Node and process metrics', async () => {
    const body = await new MetricsService().scrape()

    expect(body).toContain('process_cpu_user_seconds_total')
    expect(body).toContain('nodejs_eventloop_lag_seconds')
  })

  it('counts per label value and per instance', async () => {
    const first = new MetricsService()
    const second = new MetricsService()

    first.metrics.sends.inc({ result: 'sent' })
    first.metrics.sends.inc({ result: 'sent' })
    first.metrics.sends.inc({ result: 'failed' })

    const body = await first.scrape()
    expect(body).toContain('gw_send_total{result="sent"} 2')
    expect(body).toContain('gw_send_total{result="failed"} 1')
    expect(await second.scrape()).not.toContain('gw_send_total{result="sent"}')
  })

  it('observes histograms into the configured buckets', async () => {
    const service = new MetricsService()

    service.metrics.orderingHoldSeconds.observe(0.3)

    const body = await service.scrape()
    expect(body).toContain('gw_ordering_hold_seconds_bucket{le="0.25"} 0')
    expect(body).toContain('gw_ordering_hold_seconds_bucket{le="0.5"} 1')
    expect(body).toContain('gw_ordering_hold_seconds_count 1')
  })

  it('answers with the Prometheus content type', () => {
    expect(new MetricsService().contentType).toContain('text/plain')
  })
})
