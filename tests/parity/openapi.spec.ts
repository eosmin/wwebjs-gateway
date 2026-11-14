import { buildDocsModel, type DocsModel } from '../../scripts/lib/docs-model.js'
import { findOpenApiProblems } from '../../scripts/lib/openapi-check.js'
import { AppModule } from '../../src/app.module.js'
import { collectOperations } from '../../src/parity/operation-links.js'

let model: DocsModel

beforeAll(async () => {
  model = await buildDocsModel()
}, 60_000)

// TDD §6.13: every operation of the registry is in the OpenAPI document, with its scope and a
// success response schema
describe('OpenAPI completeness', () => {
  it('has every @WaOperation of the controllers in the registry the document is built from', async () => {
    const declared = (await collectOperations(AppModule)).map(operation => operation.id).sort()

    expect(model.operations.map(({ meta }) => meta.id).sort()).toEqual(declared)
  })

  it('documents every operation with its scope and a success response schema', () => {
    expect(
      findOpenApiProblems(
        model.document,
        model.operations.map(({ meta }) => meta)
      )
    ).toEqual([])
  })

  it('lists every operation of the registry under its id', () => {
    const documented = new Set(model.routes.keys())

    expect(model.operations.map(({ meta }) => meta.id).filter(id => !documented.has(id))).toEqual(
      []
    )
  })
})
