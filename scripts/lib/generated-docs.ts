import { renderConfigReference } from './config-reference.js'
import { buildDocsModel } from './docs-model.js'
import { renderErrors } from './errors-doc.js'
import { renderEvents } from './events-doc.js'
import { renderMetrics } from './metrics-doc.js'
import { renderOperationsList } from './operations-doc.js'
import { renderParityMatrix } from './parity-doc.js'
import { renderWebsocketCommands } from './websocket-doc.js'

export interface GeneratedDoc {
  path: string
  render: () => string | Promise<string>
}

// The registry and the OpenAPI document are built once and shared by the four files derived from them
export const renderOpenApi = async (): Promise<string> =>
  `${JSON.stringify((await buildDocsModel()).document, null, 2)}\n`

export const GENERATED_DOCS: readonly GeneratedDoc[] = [
  { path: 'docs/config-reference.md', render: renderConfigReference },
  { path: 'docs/errors.md', render: renderErrors },
  { path: 'docs/events.md', render: renderEvents },
  { path: 'docs/metrics.md', render: renderMetrics },
  { path: 'docs/openapi.json', render: renderOpenApi },
  {
    path: 'docs/operations-list.md',
    render: async () => renderOperationsList(await buildDocsModel())
  },
  {
    path: 'docs/websocket-commands.md',
    render: async () => renderWebsocketCommands(await buildDocsModel())
  },
  { path: 'docs/parity-matrix.md', render: async () => renderParityMatrix(await buildDocsModel()) }
]
