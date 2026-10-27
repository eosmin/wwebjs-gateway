import { METRIC_DEFINITIONS } from '../../src/infra/metrics/metric-definitions.js'

import { renderMetrics } from './metrics-doc.js'

describe('renderMetrics', () => {
  it('lists every series with its type, labels and meaning', () => {
    const doc = renderMetrics()

    for (const { name, type, help } of Object.values<{ name: string; type: string; help: string }>(
      METRIC_DEFINITIONS
    )) {
      expect(doc).toContain(`| \`${name}\` | ${type} |`)
      expect(doc).toContain(help)
    }
    expect(doc).toContain('| `gw_wa_call_errors_total` | counter | `op`, `type` |')
    expect(doc).toContain('| `gw_watchdog_restarts_total` | counter | - |')
  })

  it('keeps every table row on one line', () => {
    const rows = renderMetrics()
      .split('\n')
      .filter(line => line.startsWith('| `'))

    expect(rows).toHaveLength(Object.keys(METRIC_DEFINITIONS).length)
  })
})
