import { readFileSync } from 'node:fs'

import {
  analyzeCalls,
  buildReport,
  coverageOk,
  extractFactories,
  findCallsites,
  isBuild,
  newFindings,
  renderReport,
  validateKnown,
  wantsIssue,
  type PageCheck
} from './wa-web-sweep.js'

const factory = (name: string, body: string): string =>
  `__d("${name}",[],(function(a,b,c,d,e,f,g){"use strict";${body}}),66);`

const library = (text: string): { file: string; text: string }[] => [
  { file: 'src/Client.js', text }
]

describe('findCallsites', () => {
  it('reads direct calls with their arguments and line', () => {
    const calls = findCallsites(
      library(`x\nawait window.require('WAWebFoo').bar(chat, { a: [1, 2], b: 'x,y' }, 3)`)
    )

    expect(calls).toEqual([
      {
        file: 'src/Client.js',
        line: 2,
        mod: 'WAWebFoo',
        fn: 'bar',
        argc: 3,
        args: ['chat', "{ a: [1, 2], b: 'x,y' }", '3']
      }
    ])
  })

  it('does not read a member chain or another object that reuses the alias name', () => {
    const calls = findCallsites(
      library(
        `const Store = window.require('WAWebFoo');\nStore.a();\nthis.Store.b();\nwindow.Store.c();`
      )
    )

    expect(calls.map(call => call.fn)).toEqual(['a'])
  })

  it('reads the calls made through an alias, and counts no argument for an empty call', () => {
    const calls = findCallsites(
      library(`const Foo = window.require('WAWebFoo');\nFoo.ping();\nFoo.pong(a);`)
    )

    expect(calls.map(call => [call.fn, call.argc])).toEqual([
      ['ping', 0],
      ['pong', 1]
    ])
  })
})

describe('extractFactories', () => {
  it('keeps the factories of the modules asked for, with braces inside strings', () => {
    const bundle = [
      factory('WAWebFoo', `function h(x){return "}{"+x}g.bar=h`),
      factory('WAWebOther', 'g.z=1')
    ].join('\n')

    const found = extractFactories([bundle], new Set(['WAWebFoo']))

    expect([...found.keys()]).toEqual(['WAWebFoo'])
    expect(found.get('WAWebFoo')).toContain('g.bar=h')
    expect(found.get('WAWebFoo')?.endsWith('}')).toBe(true)
  })
})

const sweep = (libraryText: string, bundleText: string) => {
  const calls = findCallsites(library(libraryText))
  const modules = new Set(calls.map(call => call.mod))
  return analyzeCalls(calls, extractFactories([bundleText], modules))
}

describe('analyzeCalls', () => {
  it('accepts a call that matches the declared parameters', () => {
    const rows = sweep(
      `window.require('WAWebFoo').bar(a, b)`,
      factory('WAWebFoo', 'function h(x,y){return x+y}g.bar=h')
    )

    expect(rows.map(row => row.status)).toEqual(['ok'])
  })

  it('flags a library that passes more arguments than the page declares', () => {
    const rows = sweep(
      `window.require('WAWebFoo').bar(a, b, c)`,
      factory('WAWebFoo', 'function h(x,y){return x+y}g.bar=h')
    )

    expect(rows[0]).toMatchObject({ status: 'arity', declared: 2, target: 'WAWebFoo.bar' })
  })

  it('flags a function that now declares nothing while the library still passes arguments', () => {
    const rows = sweep(
      `window.require('WAWebFoo').bar(a, b)`,
      factory('WAWebFoo', 'function h(){return 1}g.bar=h')
    )

    expect(rows[0]?.status).toBe('arity')
  })

  it('flags one parameter that is only read as an object when the library passes several', () => {
    const rows = sweep(
      `window.require('WAWebFoo').bar(a, b)`,
      factory('WAWebFoo', 'function h(o){return o.a+o.b}g.bar=h')
    )

    expect(rows[0]?.status).toBe('object-shape')
  })

  it('follows the asyncToGenerator wrapper to the real parameters', () => {
    const body =
      'function h(){return i.apply(this,arguments)}' +
      'function i(){return i=c("asyncToGenerator")(function*(x,y){return x}),i.apply(this,arguments)}' +
      'g.bar=h'
    const rows = sweep(`window.require('WAWebFoo').bar(a, b, c)`, factory('WAWebFoo', body))

    expect(rows[0]).toMatchObject({ status: 'arity', declared: 2 })
  })

  it('does not judge a module that is not in the scripts or an export it cannot follow', () => {
    const rows = sweep(
      `window.require('WAWebLazy').a(x);window.require('WAWebFoo').nope(x)`,
      factory('WAWebFoo', 'g.other=1')
    )

    expect(rows.map(row => row.status)).toEqual(['module-not-loaded', 'unresolved'])
  })
})

const page = (overrides: Partial<PageCheck> = {}): PageCheck => ({
  build: '2.3000.1000000001',
  notLoaded: [],
  notFunction: [],
  ...overrides
})

describe('buildReport', () => {
  const rows = sweep(
    `window.require('WAWebFoo').bar(a, b, c);window.require('WAWebFoo').baz(a)`,
    factory('WAWebFoo', 'function h(x,y){return 1}function k(x){return x}g.bar=h;g.baz=k')
  )

  it('lists what changed, with where the library calls it, and counts what it could not judge', () => {
    const report = buildReport({
      rows,
      page: page({ notFunction: ['WAWebFoo.baz'] }),
      known: [],
      verified: '2.3000.1000000000'
    })

    expect(report.findings.map(finding => [finding.target, finding.kind])).toEqual([
      ['WAWebFoo.bar', 'arity'],
      ['WAWebFoo.baz', 'function-missing']
    ])
    expect(report.findings[0]?.calls).toEqual(['src/Client.js:1'])
    expect(report.callsites).toBe(2)
    expect(report.modules).toBe(1)
    expect(wantsIssue(report)).toBe(true)
  })

  it('does not count a known target as new, and asks for no issue when only known ones remain', () => {
    const report = buildReport({
      rows,
      page: page({ notFunction: ['WAWebFoo.baz'] }),
      known: [
        { target: 'WAWebFoo.bar', kind: 'arity', note: 'plan 10.4' },
        { target: 'WAWebFoo.baz', kind: 'function-missing', note: 'plan 10.4' }
      ],
      verified: '2.3000.1000000000'
    })

    expect(newFindings(report)).toEqual([])
    expect(wantsIssue(report)).toBe(false)
    expect(renderReport(report)).toContain('New findings: none')
  })

  it('lets a known arity note cover only the arity, not a later removal of the same target', () => {
    const report = buildReport({
      rows,
      page: page({ notFunction: ['WAWebFoo.bar'] }),
      known: [{ target: 'WAWebFoo.bar', kind: 'arity', note: 'plan 10.4' }],
      verified: undefined
    })

    expect(newFindings(report).map(finding => [finding.target, finding.kind])).toEqual([
      ['WAWebFoo.bar', 'function-missing']
    ])
  })

  it('fails closed: a sweep that could judge too little is not a clean report', () => {
    const lazy = analyzeCalls(findCallsites(library(`window.require('WAWebGone').a(x)`)), new Map())
    const empty = buildReport({ rows: lazy, page: page(), known: [], verified: undefined })

    expect(empty.judged).toBe(0)
    expect(coverageOk(empty)).toBe(false)
    expect(coverageOk(buildReport({ rows, page: page(), known: [], verified: undefined }))).toBe(
      true
    )
  })

  it('asks for no issue for the verified build itself', () => {
    const report = buildReport({ rows, page: page(), known: [], verified: '2.3000.1000000001' })

    expect(report.findings).not.toEqual([])
    expect(wantsIssue(report)).toBe(false)
  })

  it('renders names of the library and of the page, and nothing else', () => {
    const text = renderReport(buildReport({ rows, page: page(), known: [], verified: undefined }))

    expect(text).toContain('`WAWebFoo.bar`')
    expect(text).toContain('src/Client.js:1')
    expect(text).toContain('verified build: none set')
  })
})

describe('isBuild and validateKnown', () => {
  it('accepts only the form WhatsApp Web uses for its build', () => {
    expect(isBuild('2.3000.1054509844')).toBe(true)
    for (const bad of ['', 'latest', '2.3000.', '2.3000.1\n- x', '2.2412.54', '2.3000.1 `x`']) {
      expect(isBuild(bad)).toBe(false)
    }
  })

  it('requires Module.function and a note, and no repeats', () => {
    expect(validateKnown([{ target: 'A.b', kind: 'arity', note: 'plan 10.4' }])).toEqual([
      { target: 'A.b', kind: 'arity', note: 'plan 10.4' }
    ])
    expect(() => validateKnown({})).toThrow('array')
    expect(() => validateKnown([{ target: 'Ab', kind: 'arity', note: 'x' }])).toThrow(
      'Module.function'
    )
    expect(() => validateKnown([{ target: 'A.b', kind: 'arity', note: ' ' }])).toThrow('note')
    expect(() =>
      validateKnown([
        { target: 'A.b', kind: 'arity', note: 'x' },
        { target: 'A.b', kind: 'arity', note: 'y' }
      ])
    ).toThrow('repeats')
  })
})

describe('the files the workflow reads', () => {
  it('has a verified build of the form WhatsApp Web uses', () => {
    const text = readFileSync('ops/wa-web-verified-build.txt', 'utf8')

    expect(text).toMatch(/^2\.3000\.\d+\n$/)
    expect(isBuild(text.trim())).toBe(true)
  })

  it('has a known list that is valid and names a place for every entry', () => {
    const known = validateKnown(JSON.parse(readFileSync('ops/wa-web-sweep-known.json', 'utf8')))

    expect(known.length).toBeGreaterThan(0)
  })
})
