import { renderConfigReference } from './config-reference.js'
import { renderErrors } from './errors-doc.js'
import { renderEvents } from './events-doc.js'
import { renderMetrics } from './metrics-doc.js'

export interface GeneratedDoc {
  path: string
  render: () => string
}

// Later phases add the other generated files (operations, parity matrix)
export const GENERATED_DOCS: readonly GeneratedDoc[] = [
  { path: 'docs/config-reference.md', render: renderConfigReference },
  { path: 'docs/errors.md', render: renderErrors },
  { path: 'docs/events.md', render: renderEvents },
  { path: 'docs/metrics.md', render: renderMetrics }
]
