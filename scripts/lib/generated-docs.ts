import { renderConfigReference } from './config-reference.js'

export interface GeneratedDoc {
  path: string
  render: () => string
}

// Later phases add the other generated files (events, operations, parity matrix, metrics, errors)
export const GENERATED_DOCS: readonly GeneratedDoc[] = [
  { path: 'docs/config-reference.md', render: renderConfigReference }
]
