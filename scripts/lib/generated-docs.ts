import { renderConfigReference } from './config-reference.js'
import { renderErrors } from './errors-doc.js'

export interface GeneratedDoc {
  path: string
  render: () => string
}

// Later phases add the other generated files (events, operations, parity matrix, metrics, errors)
export const GENERATED_DOCS: readonly GeneratedDoc[] = [
  { path: 'docs/config-reference.md', render: renderConfigReference },
  { path: 'docs/errors.md', render: renderErrors }
]
