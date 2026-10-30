export interface MetricDefinition {
  name: string
  type: 'counter' | 'gauge' | 'histogram'
  help: string
  labels: readonly string[]
  // Upper bounds in seconds; histograms only
  buckets?: readonly number[]
}

const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const

// Every series the gateway exposes, and the only place that names one: the registry is built from it
// and docs/metrics.md is generated from it. Node and process metrics (collectDefaultMetrics) come on top.
export const METRIC_DEFINITIONS = {
  sessions: {
    name: 'gw_sessions',
    type: 'gauge',
    help: 'Sessions currently in each status.',
    labels: ['status']
  },
  httpRequests: {
    name: 'gw_http_requests_total',
    type: 'counter',
    help: 'HTTP responses, by method, route pattern and status (`unmatched` when no route matched).',
    labels: ['method', 'route', 'status']
  },
  httpDurationSeconds: {
    name: 'gw_http_request_duration_seconds',
    type: 'histogram',
    help: 'Seconds from receiving an HTTP request to the end of its response, by method and route pattern.',
    labels: ['method', 'route'],
    buckets: LATENCY_BUCKETS
  },
  events: {
    name: 'gw_events_total',
    type: 'counter',
    help: 'Events received from WhatsApp, by event name.',
    labels: ['event']
  },
  eventsSkipped: {
    name: 'gw_events_skipped_total',
    type: 'counter',
    help: 'Events the adapter could not map and dropped, by event name.',
    labels: ['event']
  },
  orderingHeld: {
    name: 'gw_ordering_held_total',
    type: 'counter',
    help: 'Inbound messages the order buffer held back to wait for earlier ones.',
    labels: []
  },
  orderingReordered: {
    name: 'gw_ordering_reordered_total',
    type: 'counter',
    help: 'Inbound messages published in a different order than they arrived.',
    labels: []
  },
  orderingHoldSeconds: {
    name: 'gw_ordering_hold_seconds',
    type: 'histogram',
    help: 'Seconds a held inbound message waited in the order buffer.',
    labels: [],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30]
  },
  pipelineErrors: {
    name: 'gw_pipeline_errors_total',
    type: 'counter',
    help: 'Failures of the event pipeline, by stage (dedupe, store, publish, replay, event).',
    labels: ['stage']
  },
  sends: {
    name: 'gw_send_total',
    type: 'counter',
    help: 'Outbound sends, by result.',
    labels: ['result']
  },
  sendDurationSeconds: {
    name: 'gw_send_duration_seconds',
    type: 'histogram',
    help: 'Seconds from taking a send job to its outcome.',
    labels: [],
    buckets: LATENCY_BUCKETS
  },
  sendQueueDepth: {
    name: 'gw_send_queue_depth',
    type: 'gauge',
    help: 'Send jobs waiting in the queue of each session.',
    labels: ['session']
  },
  webhookDeliveries: {
    name: 'gw_webhook_deliveries_total',
    type: 'counter',
    help: 'Webhook delivery attempts, by result.',
    labels: ['result']
  },
  webhookDurationSeconds: {
    name: 'gw_webhook_duration_seconds',
    type: 'histogram',
    help: 'Seconds a webhook delivery attempt took.',
    labels: [],
    buckets: LATENCY_BUCKETS
  },
  waCallDurationSeconds: {
    name: 'gw_wa_call_duration_seconds',
    type: 'histogram',
    help: 'Seconds a call into whatsapp-web.js took, by operation.',
    labels: ['op'],
    buckets: LATENCY_BUCKETS
  },
  waCallErrors: {
    name: 'gw_wa_call_errors_total',
    type: 'counter',
    help: 'Failed calls into whatsapp-web.js, by operation and error type.',
    labels: ['op', 'type']
  },
  watchdogRestarts: {
    name: 'gw_watchdog_restarts_total',
    type: 'counter',
    help: 'Sessions the watchdog restarted.',
    labels: []
  },
  reconcileRecovered: {
    name: 'gw_reconcile_recovered_total',
    type: 'counter',
    help: 'Messages the reconciliation pass recovered after a reconnect.',
    labels: []
  }
} as const satisfies Record<string, MetricDefinition>
