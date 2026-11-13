export interface MetricDefinition {
  name: string
  type: 'counter' | 'gauge' | 'histogram'
  help: string
  labels: readonly string[]
  // Upper bounds in seconds; histograms only
  buckets?: readonly number[]
  // Label sets written at 0 when the registry is built. A counter series that first appears at 1 gives
  // no `increase()` in Prometheus, so an alert on the first logout would stay silent: every value of a
  // label that has a fixed set is seeded
  seed?: readonly Record<string, string>[]
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
    help: 'Failures of the event pipeline, by stage (dedupe, store, publish, replay, event, policy).',
    labels: ['stage'],
    seed: [
      { stage: 'dedupe' },
      { stage: 'store' },
      { stage: 'publish' },
      { stage: 'replay' },
      { stage: 'event' },
      { stage: 'policy' }
    ]
  },
  sends: {
    name: 'gw_send_total',
    type: 'counter',
    help: 'Outbound sends, by result.',
    labels: ['result'],
    seed: [
      { result: 'sent' },
      { result: 'WHATSAPP_ERROR' },
      { result: 'WHATSAPP_TIMEOUT' },
      { result: 'SESSION_NOT_READY' },
      { result: 'INTERNAL' },
      { result: 'UNKNOWN_OUTCOME' }
    ]
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
    help: "Webhook deliveries, by result: each attempt's outcome (`success`; `retry`, failed and will be tried again; `failed`, failed for the last time; `dropped`, the job ended without an attempt because its webhook is gone or disabled or the delivery was already made), `unlogged` (no row could be stored), `not_queued` (the job could not be queued) and `swept` (a pending row with no job to run it was sent to the dead letters by the retention sweep).",
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
    help: 'Sessions the watchdog restarted (a frozen browser, a start that never ended, memory). A browser that dies is not counted here: see gw_browser_recoveries_total.',
    labels: []
  },
  browserRecoveries: {
    name: 'gw_browser_recoveries_total',
    type: 'counter',
    help: 'Sessions the adapter found with their browser or page gone (killed, crashed, closed) and sent to reconnect, by code (BROWSER_DISCONNECTED, PAGE_CLOSED, PAGE_CRASHED, other).',
    labels: ['code'],
    seed: [
      { code: 'BROWSER_DISCONNECTED' },
      { code: 'PAGE_CLOSED' },
      { code: 'PAGE_CRASHED' },
      { code: 'other' }
    ]
  },
  authQuarantined: {
    name: 'gw_auth_quarantined_total',
    type: 'counter',
    help: 'Saved logins the gateway moved to quarantine on its own because WhatsApp refused them (the account was unlinked while the gateway was stopped).',
    labels: []
  },
  logouts: {
    name: 'gw_logout_total',
    type: 'counter',
    help: 'Sessions WhatsApp Web logged out on its own, by the reason it gave (client_fatal, sync_fail, history_sync_timeout, account_locked, unspecified when it gave none, other).',
    labels: ['reason'],
    seed: [
      { reason: 'client_fatal' },
      { reason: 'sync_fail' },
      { reason: 'history_sync_timeout' },
      { reason: 'account_locked' },
      { reason: 'unspecified' },
      { reason: 'other' }
    ]
  },
  waWebBuild: {
    name: 'gw_wa_web_build_info',
    type: 'gauge',
    help: 'Sessions running each WhatsApp Web build, by version (2.3000.<number>, or unknown).',
    labels: ['version']
  },
  waWebDrift: {
    name: 'gw_wa_web_drift_errors_total',
    type: 'counter',
    help: 'Calls that failed because WhatsApp Web changed under the patch of whatsapp-web.js, by kind (signature: a function it no longer exports; lazy_module: a module no bundle loaded) and target (Module.function, or other).',
    labels: ['kind', 'target']
  },
  policyDecisions: {
    name: 'gw_policy_decisions_total',
    type: 'counter',
    help: 'Decisions of the send policy that are not a plain allow at enqueue, by rule (`none` for an allow) and decision (allow, delay, reject).',
    labels: ['rule', 'decision']
  },
  policyDelaySeconds: {
    name: 'gw_policy_delay_seconds',
    type: 'histogram',
    help: 'Seconds the send policy asked a job to wait.',
    labels: [],
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 1800, 3600, 21600]
  },
  suppressedChats: {
    name: 'gw_suppressed_chats',
    type: 'gauge',
    help: 'Chats on the suppression lists of all sessions.',
    labels: []
  },
  reconcileRecovered: {
    name: 'gw_reconcile_recovered_total',
    type: 'counter',
    help: 'Messages the reconciliation pass recovered after a reconnect.',
    labels: []
  }
} as const satisfies Record<string, MetricDefinition>
