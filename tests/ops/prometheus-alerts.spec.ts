import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'yaml'

import { ErrorCode } from '../../src/common/errors.js'
import {
  METRIC_DEFINITIONS,
  type MetricDefinition
} from '../../src/infra/metrics/metric-definitions.js'
import { SESSION_STATUSES } from '../../src/types/dto.js'
import { WA_EVENT_NAMES } from '../../src/types/events.js'

// ops/prometheus-alerts.yml is the rules file an operator loads into Prometheus. These tests fail when
// it does not parse, when a rule lacks what a person on call needs, or when it names a series or a
// label the gateway does not have (a renamed metric would otherwise leave an alert that never fires).
interface Rule {
  alert?: string
  expr?: string
  for?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
}
interface RuleFile {
  groups?: { name?: string; rules?: Rule[] }[]
}

const FILE = join(process.cwd(), 'ops/prometheus-alerts.yml')
const text = readFileSync(FILE, 'utf8')
const file = parse(text) as RuleFile
const rules = (file.groups ?? []).flatMap(group => group.rules ?? [])

const DEFINITIONS: readonly MetricDefinition[] = Object.values(METRIC_DEFINITIONS)
const NAMES = new Map(DEFINITIONS.map(definition => [definition.name, definition]))
// Series Prometheus itself writes for every target
const PROMETHEUS_SERIES = new Set(['up'])
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count']

// `name` or `name{label="x", other=~"y"}` for every series of the form gw_* or up in an expression
const SELECTOR = /\b(gw_[a-z0-9_]+|up)\b(?:\{([^}]*)\})?/g

function seriesOf(expression: string): { name: string; labels: string[] }[] {
  return [...expression.matchAll(SELECTOR)].map(match => ({
    name: match[1] ?? '',
    labels: [...(match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)/g)].map(
      label => label[1] ?? ''
    )
  }))
}

function definitionOf(name: string): MetricDefinition | undefined {
  const direct = NAMES.get(name)
  if (direct) return direct
  const suffix = HISTOGRAM_SUFFIXES.find(candidate => name.endsWith(candidate))
  const base = suffix === undefined ? undefined : NAMES.get(name.slice(0, -suffix.length))
  return base?.type === 'histogram' ? base : undefined
}

describe('ops/prometheus-alerts.yml', () => {
  it('parses and has alert rules', () => {
    expect(file.groups?.length).toBeGreaterThan(0)
    expect(rules.length).toBeGreaterThanOrEqual(10)
  })

  it('gives every rule a name, an expression, a duration, a severity and text for a person', () => {
    for (const rule of rules) {
      const name = rule.alert ?? '(no name)'
      expect({ name, alert: typeof rule.alert }).toEqual({ name, alert: 'string' })
      expect({ name, expr: typeof rule.expr }).toEqual({ name, expr: 'string' })
      expect({ name, for: typeof rule.for }).toEqual({ name, for: 'string' })
      expect({
        name,
        severity: ['critical', 'warning', 'info'].includes(rule.labels?.['severity'] ?? '')
      }).toEqual({ name, severity: true })
      expect({ name, summary: (rule.annotations?.['summary'] ?? '').length > 10 }).toEqual({
        name,
        summary: true
      })
      // What fires it, and what to do: the two things the person reads at night
      expect({ name, description: (rule.annotations?.['description'] ?? '').length > 40 }).toEqual({
        name,
        description: true
      })
      expect({ name, action: (rule.annotations?.['action'] ?? '').length > 20 }).toEqual({
        name,
        action: true
      })
    }
  })

  it('names each alert once', () => {
    const names = rules.map(rule => rule.alert)
    expect(new Set(names).size).toBe(names.length)
  })

  it('cites only series and labels the gateway defines', () => {
    for (const rule of rules) {
      for (const { name, labels } of seriesOf(rule.expr ?? '')) {
        if (PROMETHEUS_SERIES.has(name)) continue
        const definition = definitionOf(name)
        expect({ alert: rule.alert, series: name, defined: definition !== undefined }).toEqual({
          alert: rule.alert,
          series: name,
          defined: true
        })
        const allowed = new Set<string>([...(definition?.labels ?? []), 'le'])
        for (const label of labels) {
          expect({ alert: rule.alert, series: name, label, known: allowed.has(label) }).toEqual({
            alert: rule.alert,
            series: name,
            label,
            known: true
          })
        }
      }
    }
  })

  // A label value that no series has makes a rule that never fires, and the check of the names above
  // cannot see it: the values of the labels with a fixed set are checked here
  const KNOWN_VALUES: Record<string, ReadonlySet<string>> = {
    'gw_sessions.status': new Set(SESSION_STATUSES),
    'gw_send_total.result': new Set(['sent', ...Object.values(ErrorCode)]),
    'gw_webhook_deliveries_total.result': new Set(['success', 'retry', 'failed', 'dropped']),
    'gw_events_total.event': new Set(WA_EVENT_NAMES),
    'gw_logout_total.reason': new Set(
      (METRIC_DEFINITIONS.logouts.seed ?? []).map(labels => labels['reason'] ?? '')
    )
  }

  it('uses only values of fixed labels that the gateway can write', () => {
    for (const rule of rules) {
      for (const match of (rule.expr ?? '').matchAll(/\b(gw_[a-z0-9_]+)\{([^}]*)\}/g)) {
        for (const matcher of (match[2] ?? '').matchAll(
          /([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"/g
        )) {
          const allowed = KNOWN_VALUES[`${match[1]}.${matcher[1]}`]
          if (allowed === undefined) continue
          // A pattern of the form a|b|c is a set of values; `5..` style patterns are not of these labels
          for (const value of (matcher[3] ?? '').split('|')) {
            expect({
              alert: rule.alert,
              series: match[1],
              label: matcher[1],
              value,
              known: allowed.has(value)
            }).toEqual({
              alert: rule.alert,
              series: match[1],
              label: matcher[1],
              value,
              known: true
            })
          }
        }
      }
    }
  })

  it('is valid for the shapes Prometheus rejects at load: balanced brackets and quotes, a duration', () => {
    for (const rule of rules) {
      const expr = rule.expr ?? ''
      const count = (character: string): number => expr.split(character).length - 1
      expect({ alert: rule.alert, round: count('(') - count(')') }).toEqual({
        alert: rule.alert,
        round: 0
      })
      expect({ alert: rule.alert, curly: count('{') - count('}') }).toEqual({
        alert: rule.alert,
        curly: 0
      })
      expect({ alert: rule.alert, square: count('[') - count(']') }).toEqual({
        alert: rule.alert,
        square: 0
      })
      expect({ alert: rule.alert, quotes: count('"') % 2 }).toEqual({
        alert: rule.alert,
        quotes: 0
      })
      expect({ alert: rule.alert, for: /^\d+[smhd]$/.test(rule.for ?? '') }).toEqual({
        alert: rule.alert,
        for: true
      })
      for (const range of expr.matchAll(/\[([^\]]*)\]/g)) {
        expect({ alert: rule.alert, range: /^\d+[smhd]$/.test(range[1] ?? '') }).toEqual({
          alert: rule.alert,
          range: true
        })
      }
    }
  })

  it('has an alert for each of the signals that mean a session or an account is at risk', () => {
    const cited = new Set(
      rules.flatMap(rule => seriesOf(rule.expr ?? '').map(series => series.name))
    )
    for (const metric of [
      'gw_logout_total',
      'gw_auth_quarantined_total',
      'gw_watchdog_restarts_total',
      'gw_browser_recoveries_total',
      'gw_reconcile_recovered_total',
      'gw_events_total',
      'gw_sessions',
      'gw_wa_web_build_info',
      'gw_send_queue_depth',
      'gw_http_requests_total',
      'gw_webhook_deliveries_total',
      'gw_pipeline_errors_total'
    ]) {
      expect({ metric, cited: cited.has(metric) }).toEqual({ metric, cited: true })
    }
  })

  it('does not cite a series the gateway never writes', () => {
    // Defined but without an emitter today: an alert on them would never fire
    const mute = ['gw_wa_call_duration_seconds', 'gw_wa_call_errors_total']
    for (const rule of rules) {
      for (const { name } of seriesOf(rule.expr ?? '')) {
        expect({ alert: rule.alert, name, mute: mute.some(item => name.startsWith(item)) }).toEqual(
          {
            alert: rule.alert,
            name,
            mute: false
          }
        )
      }
    }
  })
})
