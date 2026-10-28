import { Injectable } from '@nestjs/common'
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client'

import { METRIC_DEFINITIONS, type MetricDefinition } from './metric-definitions.js'

type Definition<L extends string> = MetricDefinition & { labels: readonly L[] }

const counter = <L extends string>(registry: Registry, def: Definition<L>): Counter<L> =>
  new Counter({ name: def.name, help: def.help, labelNames: def.labels, registers: [registry] })

const gauge = <L extends string>(registry: Registry, def: Definition<L>): Gauge<L> =>
  new Gauge({ name: def.name, help: def.help, labelNames: def.labels, registers: [registry] })

const histogram = <L extends string>(registry: Registry, def: Definition<L>): Histogram<L> =>
  new Histogram({
    name: def.name,
    help: def.help,
    labelNames: def.labels,
    buckets: def.buckets === undefined ? undefined : [...def.buckets],
    registers: [registry]
  })

export interface Metrics {
  sessions: Gauge<'status'>
  events: Counter<'event'>
  orderingHeld: Counter
  orderingReordered: Counter
  orderingHoldSeconds: Histogram
  pipelineErrors: Counter<'stage'>
  sends: Counter<'result'>
  sendDurationSeconds: Histogram
  sendQueueDepth: Gauge<'session'>
  webhookDeliveries: Counter<'result'>
  webhookDurationSeconds: Histogram
  waCallDurationSeconds: Histogram<'op'>
  waCallErrors: Counter<'op' | 'type'>
  watchdogRestarts: Counter
  reconcileRecovered: Counter
}

export function createMetrics(registry: Registry): Metrics {
  const d = METRIC_DEFINITIONS
  return {
    sessions: gauge(registry, d.sessions),
    events: counter(registry, d.events),
    orderingHeld: counter(registry, d.orderingHeld),
    orderingReordered: counter(registry, d.orderingReordered),
    orderingHoldSeconds: histogram(registry, d.orderingHoldSeconds),
    pipelineErrors: counter(registry, d.pipelineErrors),
    sends: counter(registry, d.sends),
    sendDurationSeconds: histogram(registry, d.sendDurationSeconds),
    sendQueueDepth: gauge(registry, d.sendQueueDepth),
    webhookDeliveries: counter(registry, d.webhookDeliveries),
    webhookDurationSeconds: histogram(registry, d.webhookDurationSeconds),
    waCallDurationSeconds: histogram(registry, d.waCallDurationSeconds),
    waCallErrors: counter(registry, d.waCallErrors),
    watchdogRestarts: counter(registry, d.watchdogRestarts),
    reconcileRecovered: counter(registry, d.reconcileRecovered)
  }
}

// Owns its own registry (never the global one), so each application instance and each spec counts apart
@Injectable()
export class MetricsService {
  readonly registry = new Registry()
  readonly metrics: Metrics = createMetrics(this.registry)

  constructor() {
    collectDefaultMetrics({ register: this.registry })
  }

  // The body of GET /metrics
  scrape(): Promise<string> {
    return this.registry.metrics()
  }

  get contentType(): string {
    return this.registry.contentType
  }
}
