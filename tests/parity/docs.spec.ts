import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { findAdrProblems } from '../../scripts/lib/adr.js'
import { curlRequests, matchesRoute } from '../../scripts/lib/curl-examples.js'
import { findBrokenLinks, internalLinks } from '../../scripts/lib/doc-links.js'
import { findPlaceholders } from '../../scripts/lib/doc-placeholders.js'
import { buildDocsModel } from '../../scripts/lib/docs-model.js'
import { GENERATED_DOCS } from '../../scripts/lib/generated-docs.js'
import { FEATURE_ENV, PENDING_GUIDES, WRITTEN_GUIDES } from '../../scripts/lib/guides.js'
import { readWwebjsSymbols } from '../../scripts/lib/wwebjs-symbols.js'
import { envSchema } from '../../src/config/env.schema.js'

const read = (path: string): string => readFileSync(path, 'utf8')

// The plan and the TDD are working documents, not guides; the ADRs are listed by their own index
const NOT_GUIDES = ['docs/IMPLEMENTATION_PLAN.md', 'docs/TDD.md']
const GUIDE_FILES = readdirSync('docs')
  .filter(file => /\.(md|json)$/.test(file))
  .map(file => `docs/${file}`)
const MARKDOWN_FILES = [
  ...GUIDE_FILES.filter(path => path.endsWith('.md') && !NOT_GUIDES.includes(path)),
  ...readdirSync('docs/adr')
    .filter(file => file.endsWith('.md'))
    .map(file => `docs/adr/${file}`)
]

const ADR_DIRECTORY = 'docs/adr'
const ADR_FILES = readdirSync(ADR_DIRECTORY)
  .filter(file => /^\d{4}-.+\.md$/.test(file))
  .sort()

describe('docs', () => {
  it.each(GENERATED_DOCS.map(doc => [doc.path, doc] as const))(
    '%s equals a fresh generation',
    async (_path, doc) => {
      expect(read(doc.path)).toBe(await doc.render())
    },
    60_000
  )

  // What each generated reference has to name, so that an operation, a command or a symbol cannot
  // go missing from it (TDD §6.13)
  it('names every operation id in operations-list.md and every socket command in websocket-commands.md', async () => {
    const { operations } = await buildDocsModel()
    const list = read('docs/operations-list.md')
    const commands = read('docs/websocket-commands.md')

    expect(operations.filter(({ meta }) => !list.includes(`\`${meta.id}\``))).toEqual([])
    expect(
      operations.filter(
        ({ meta }) => meta.socket !== undefined && !commands.includes(`\`${meta.socket.command}\``)
      )
    ).toEqual([])
  }, 60_000)

  it('lists every symbol of whatsapp-web.js in parity-matrix.md', () => {
    const matrix = read('docs/parity-matrix.md')

    expect(readWwebjsSymbols().filter(symbol => !matrix.includes(`\`${symbol}\``))).toEqual([])
  })

  // An unescaped pipe in a summary or a reason would add a cell to its row
  it.each(['docs/operations-list.md', 'docs/websocket-commands.md', 'docs/parity-matrix.md'])(
    '%s has the same number of cells in every row of a table',
    path => {
      const cells = (row: string): number =>
        row
          .replace(/\\./g, '')
          .replace(/`[^`]*`/g, '')
          .split('|').length
      const rows = read(path).split('\n')
      const widths = rows.map((row, index) =>
        row.startsWith('|') && !(rows[index - 1] ?? '').startsWith('|') ? cells(row) : 0
      )
      let width = 0
      const wrong = rows.filter((row, index) => {
        if (!row.startsWith('|')) return false
        width = widths[index] ? (widths[index] ?? 0) : width
        return cells(row) !== width
      })

      expect(wrong).toEqual([])
    }
  )

  it.each(WRITTEN_GUIDES)('%s exists', path => {
    expect(existsSync(path)).toBe(true)
  })

  // A guide that is still owed cannot be there already without leaving the pending list. A plain test
  // and not `it.each`: the list is empty once every guide is written, and Jest refuses an empty table
  it('has no pending guide that already exists', () => {
    expect(PENDING_GUIDES.filter(path => existsSync(path))).toEqual([])
  })

  it('has no guide outside the manifest', () => {
    const manifest = new Set([...WRITTEN_GUIDES, ...PENDING_GUIDES])

    expect(GUIDE_FILES.filter(path => !manifest.has(path) && !NOT_GUIDES.includes(path))).toEqual(
      []
    )
  })

  it('does not list a guide twice', () => {
    const all = [...WRITTEN_GUIDES, ...PENDING_GUIDES]

    expect(all.filter((path, index) => all.indexOf(path) !== index)).toEqual([])
  })

  // docs/TDD.md, the plan and the ADRs quote these words as rules, so they are not checked
  it.each(WRITTEN_GUIDES.filter(path => path.endsWith('.md')))(
    '%s is finished: no placeholder word, no empty code block',
    path => {
      expect(findPlaceholders(path, read(path))).toEqual([])
    }
  )

  // The curl examples of the guides are requests the gateway can answer (TDD §6.13, docs test 5)
  it('every curl example of a guide targets a route of the registry', async () => {
    const { document } = await buildDocsModel()
    const routes = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item ?? {})
        .filter(key => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
        .map(method => ({ method: method.toUpperCase(), path }))
    )
    // Outside the OpenAPI document on purpose: the health probes and the metrics scrape
    const unregistered = curlRequests(
      WRITTEN_GUIDES.filter(path => path.endsWith('.md'))
        .map(path => `${read(path)}\n`)
        .join('')
    ).filter(request => !matchesRoute(request, routes))

    expect(unregistered).toEqual([])
  }, 60_000)

  // The variables of a feature are in the guide of that feature (docs test 7)
  it.each(Object.entries(FEATURE_ENV))(
    '%s names every variable of its feature',
    (path, feature) => {
      const names = Object.keys(envSchema.shape).filter(name => feature.test(name))
      // A guide that is still pending is checked when it is written
      const text = existsSync(path) ? read(path) : undefined

      expect(names).not.toEqual([])
      if (text !== undefined) expect(names.filter(name => !text.includes(name))).toEqual([])
    }
  )

  it.each(['README.md', ...MARKDOWN_FILES])('%s has no broken internal link', path => {
    expect(findBrokenLinks(path, read(path), { exists: existsSync, read })).toEqual([])
  })

  it('links every written guide from the README', () => {
    // A link in the text of the README, not a mention inside a code block or a code span
    const linked = new Set(internalLinks(read('README.md')).map(link => link.split('#')[0]))

    expect(WRITTEN_GUIDES.filter(path => !linked.has(path))).toEqual([])
  })
})

describe('architecture decision records', () => {
  it('has at least the records of Phase 0', () => {
    expect(ADR_FILES.length).toBeGreaterThanOrEqual(4)
  })

  it('numbers them 0001, 0002, ... with no gap and no repeat', () => {
    expect(ADR_FILES.map(file => file.slice(0, 4))).toEqual(
      ADR_FILES.map((_file, index) => String(index + 1).padStart(4, '0'))
    )
  })

  it.each(ADR_FILES)('%s is listed in the index of the folder', file => {
    expect(read(`${ADR_DIRECTORY}/README.md`)).toContain(`(${file})`)
  })

  it.each(ADR_FILES)('%s follows the template', file => {
    expect(findAdrProblems(file, read(`${ADR_DIRECTORY}/${file}`))).toEqual([])
  })

  // ADR 0003 describes the ruleset in prose; the file is what GitHub is given
  it('the ruleset file says what ADR 0003 says', () => {
    const ruleset = JSON.parse(read('deploy/github-ruleset.json')) as {
      bypass_actors: unknown[]
      rules: { type: string; parameters?: Record<string, unknown> }[]
    }
    const rule = (type: string): Record<string, unknown> | undefined =>
      ruleset.rules.find(candidate => candidate.type === type)?.parameters
    const checks = rule('required_status_checks')?.['required_status_checks'] as
      { context: string; integration_id: number }[] | undefined

    expect(ruleset.bypass_actors).toEqual([])
    expect(ruleset.rules.map(candidate => candidate.type)).toEqual(
      expect.arrayContaining(['deletion', 'non_fast_forward', 'required_linear_history'])
    )
    expect(rule('pull_request')).toMatchObject({
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
      allowed_merge_methods: ['squash']
    })
    // 15368 is the GitHub Actions app: no other app can report a check with these names
    expect(checks?.every(check => check.integration_id === 15368)).toBe(true)
    expect(checks?.map(check => check.context)).toEqual([
      'lint-and-types',
      'unit-tests',
      'integration-tests',
      'security-scan'
    ])
  })
})
