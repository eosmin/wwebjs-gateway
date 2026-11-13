// The signature sweep of WhatsApp Web (INV-signature-drift, F23-3), as pure functions. whatsapp-web.js
// reaches into the page with `window.require('Module').fn(...)`; a new build can move or reshape any of
// those functions. The sweep lists every such call of the library (as patched), finds the factory of
// each module in the scripts of a build and compares what the page declares with what the library
// passes. It is a text heuristic: it sees a change of arity and a function that is gone, not a change
// in the type of an argument. Nothing here touches the network or a browser (scripts/wa-web-sweep.ts does).

export interface SourceFile {
  file: string
  text: string
}

export interface Callsite {
  file: string
  line: number
  mod: string
  fn: string
  // Arguments the library passes
  argc: number
  args: string[]
}

export type RowStatus = 'ok' | 'arity' | 'object-shape' | 'module-not-loaded' | 'unresolved'

export interface Row {
  target: string
  status: RowStatus
  call: Callsite
  // Parameters the function declares, when they could be read
  declared: number | undefined
}

// What a loaded page says about `window.require(module)[fn]`, for each target
export interface PageCheck {
  build: string
  // `require` threw, or the module is not registered yet (a bundle that loads on demand)
  notLoaded: string[]
  // The module is there and the member is not a function
  notFunction: string[]
}

export type FindingKind = 'arity' | 'object-shape' | 'function-missing'

export interface Finding {
  target: string
  kind: FindingKind
  // Where the library makes the call (file:line of its source), at most three
  calls: string[]
  // Why a finding is not new: a note of the known list, or undefined for a new one
  known: string | undefined
}

export interface KnownTarget {
  target: string
  // A note covers one kind of change: a worse change of the same target is new
  kind: FindingKind
  note: string
}

export interface SweepReport {
  build: string
  verified: string | undefined
  callsites: number
  modules: number
  // Calls whose module was not found in the scripts the page loaded (loads on demand) or whose export
  // could not be followed: not judged
  notJudged: number
  // The part of the calls that could be judged (0 to 1)
  judged: number
  findings: Finding[]
}

// ---- Calls of the library ----------------------------------------------------------------------

// Splits the arguments of a call whose `(` is right before `start`
function splitArguments(source: string, start: number): string[] {
  let depth = 1
  let quote: string | undefined
  let current = ''
  const parts: string[] = []
  for (let i = start; i < source.length && depth > 0; i++) {
    const char = source.charAt(i)
    if (quote !== undefined) {
      current += char
      if (char === '\\') {
        current += source.charAt(++i)
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if ('([{'.includes(char)) {
      depth++
      current += char
      continue
    }
    if (')]}'.includes(char)) {
      depth--
      if (depth === 0) break
      current += char
      continue
    }
    if (char === ',' && depth === 1) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length

// Every `window.require('Module').fn(...)`, and every `X.fn(...)` where `const X = window.require('Module')`
export function findCallsites(sources: readonly SourceFile[]): Callsite[] {
  const calls: Callsite[] = []
  for (const { file, text } of sources) {
    const push = (mod: string, fn: string, index: number, afterParen: number): void => {
      const args = splitArguments(text, afterParen)
      calls.push({
        file,
        line: lineOf(text, index),
        mod,
        fn,
        argc: args.length,
        args: args.map(argument => argument.slice(0, 50))
      })
    }
    const aliases = new Map<string, string>()
    for (const match of text.matchAll(
      /(?:const|let|var)\s+(\w+)\s*=\s*window\s*\.require\(\s*'([\w.$]+)'\s*\)\s*;/g
    )) {
      const [, alias, mod] = match
      if (alias !== undefined && mod !== undefined) aliases.set(alias, mod)
    }
    for (const match of text.matchAll(
      /window\s*\.require\(\s*'([\w.$]+)'\s*\)\s*\.\s*(\w+)\s*\(/g
    )) {
      const [whole, mod, fn] = match
      if (mod !== undefined && fn !== undefined) {
        push(mod, fn, match.index, match.index + whole.length)
      }
    }
    for (const [alias, mod] of aliases) {
      for (const match of text.matchAll(
        new RegExp(`(?<![\\w$.])${alias}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g')
      )) {
        const [whole, fn] = match
        if (fn !== undefined) push(mod, fn, match.index, match.index + whole.length)
      }
    }
  }
  return calls
}

// ---- Factories of a build ----------------------------------------------------------------------

const escape = (name: string): string => name.replace(/[$]/g, '\\$')

// The index of the `}` that closes the `{` at `open` (strings skipped), or -1
function closing(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const char = source.charAt(i)
    if (char === '"' || char === "'" || char === '`') {
      for (i++; i < source.length && source.charAt(i) !== char; i++) {
        if (source.charAt(i) === '\\') i++
      }
      continue
    }
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return -1
}

// WhatsApp Web deletes the factory of a module as soon as it instantiates it, so the text of the
// scripts is what is read: `__d("Name",[deps],(function(...){...}))`
export function extractFactories(
  bundles: readonly string[],
  modules: ReadonlySet<string>
): Map<string, string> {
  const factories = new Map<string, string>()
  for (const bundle of bundles) {
    for (const match of bundle.matchAll(/__d\("([\w.$]+)",\[[^\]]*\],\(function\(/g)) {
      const name = match[1]
      if (name === undefined || !modules.has(name) || factories.has(name)) continue
      const start = match.index + match[0].length - 'function('.length
      const open = bundle.indexOf('{', start)
      const end = open === -1 ? -1 : closing(bundle, open)
      if (end !== -1) factories.set(name, bundle.slice(start, end + 1))
    }
  }
  return factories
}

// ---- Compare ---------------------------------------------------------------------------------

interface Resolved {
  params: string[]
  body: string | undefined
}

const splitParams = (list: string): string[] =>
  list
    .split(',')
    .map(param => param.trim())
    .filter(Boolean)

// Follows `exports.fn = name`, the function `name`, and the `asyncToGenerator` wrapper to the function
// that holds the real parameters. Undefined when the export cannot be followed.
function resolve(factory: string, fn: string): Resolved | undefined {
  const header = /^function\s*\(([^)]*)\)/.exec(factory)
  // The seventh parameter of a factory is `exports`
  const exportsName = header?.[1]?.split(',')[6]?.trim()
  if (exportsName === undefined || exportsName === '') return undefined
  const name = escape(exportsName)
  const assigned =
    new RegExp(`\\b${name}\\.${fn}\\s*=\\s*([\\w$]+)\\s*[,;}]`).exec(factory) ??
    new RegExp(`\\b${name}\\.${fn}\\s*=\\s*(function[^{]*)`).exec(factory)
  const id = assigned?.[1]
  if (id === undefined) return undefined
  if (id.startsWith('function')) {
    return {
      params: splitParams(/function\s*[\w$]*\(([^)]*)\)/.exec(id)?.[1] ?? ''),
      body: undefined
    }
  }
  const definition =
    new RegExp(`function\\s+${escape(id)}\\s*\\(([^)]*)\\)\\s*\\{`).exec(factory) ??
    new RegExp(`\\b${escape(id)}\\s*=\\s*function\\s*[\\w$]*\\(([^)]*)\\)\\s*\\{`).exec(factory)
  if (definition === null) return undefined
  const params = splitParams(definition[1] ?? '')
  const open = definition.index + definition[0].length - 1
  const end = closing(factory, open)
  const body = factory.slice(open, end === -1 ? undefined : end + 1)
  const wrapper = /return\s+([\w$]+)\.apply\(this,arguments\)/.exec(body)?.[1]
  if (wrapper === undefined) return { params, body }
  const inner = new RegExp(`function\\s+${escape(wrapper)}\\s*\\(\\)\\s*\\{`).exec(factory)
  if (inner === null) return { params, body }
  const innerOpen = inner.index + inner[0].length - 1
  const innerEnd = closing(factory, innerOpen)
  const innerBody = factory.slice(innerOpen, innerEnd === -1 ? undefined : innerEnd + 1)
  const generator =
    /asyncToGenerator\(function\*?\s*\(([^)]*)\)/.exec(innerBody) ??
    /function\*?\s*\(([^)]*)\)/.exec(innerBody)
  if (generator === null) return { params, body }
  return {
    params: splitParams(generator[1] ?? ''),
    body: innerBody.slice(innerBody.indexOf(generator[0]))
  }
}

// Uses of the first parameter, and how many of them read a member (`p.field`)
function firstParameterUse(resolved: Resolved): { all: number; members: number } | undefined {
  const first = resolved.params[0]
  if (first === undefined || resolved.body === undefined) return undefined
  const name = escape(first)
  const all = resolved.body.match(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g'))?.length ?? 0
  const members = resolved.body.match(new RegExp(`(?<![\\w$.])${name}\\.[\\w$]+`, 'g'))?.length ?? 0
  return { all, members }
}

export function analyzeCalls(
  calls: readonly Callsite[],
  factories: ReadonlyMap<string, string>
): Row[] {
  const cache = new Map<string, Resolved | undefined>()
  return calls.map((call): Row => {
    const target = `${call.mod}.${call.fn}`
    const factory = factories.get(call.mod)
    if (factory === undefined) {
      return { target, status: 'module-not-loaded', call, declared: undefined }
    }
    if (!cache.has(target)) cache.set(target, resolve(factory, call.fn))
    const resolved = cache.get(target)
    if (resolved === undefined) return { target, status: 'unresolved', call, declared: undefined }
    const declared = resolved.params.length
    // One parameter that is only read as `p.field`, and the library passes several: it became an object
    const use = firstParameterUse(resolved)
    if (
      declared === 1 &&
      use !== undefined &&
      use.all > 0 &&
      use.all === use.members &&
      call.argc >= 2
    ) {
      return { target, status: 'object-shape', call, declared }
    }
    // An object parameter also reads as "more arguments than declared", and the object is the cause
    if (call.argc > declared) return { target, status: 'arity', call, declared }
    return { target, status: 'ok', call, declared }
  })
}

// ---- Report ----------------------------------------------------------------------------------

const BUILD = /^2\.3000\.\d{1,20}$/

export const isBuild = (value: string): boolean => BUILD.test(value)

const place = (call: Callsite): string => `${call.file}:${String(call.line)}`

export function buildReport(input: {
  rows: readonly Row[]
  page: PageCheck
  known: readonly KnownTarget[]
  verified: string | undefined
}): SweepReport {
  const known = new Map(input.known.map(entry => [`${entry.target}|${entry.kind}`, entry.note]))
  const found = new Map<string, Finding>()
  const add = (target: string, kind: FindingKind, call: string | undefined): void => {
    const key = `${target}|${kind}`
    const finding = found.get(key) ?? {
      target,
      kind,
      calls: [],
      known: known.get(key)
    }
    if (call !== undefined && finding.calls.length < 3 && !finding.calls.includes(call)) {
      finding.calls.push(call)
    }
    found.set(key, finding)
  }
  const callsByTarget = new Map<string, string>()
  for (const row of input.rows) {
    if (!callsByTarget.has(row.target)) callsByTarget.set(row.target, place(row.call))
    if (row.status === 'arity') add(row.target, 'arity', place(row.call))
    if (row.status === 'object-shape') add(row.target, 'object-shape', place(row.call))
  }
  for (const target of input.page.notFunction) {
    add(target, 'function-missing', callsByTarget.get(target))
  }
  const judged = input.rows.filter(
    row => row.status !== 'module-not-loaded' && row.status !== 'unresolved'
  )
  return {
    build: input.page.build,
    verified: input.verified,
    callsites: input.rows.length,
    modules: new Set(input.rows.map(row => row.call.mod)).size,
    notJudged: input.rows.length - judged.length,
    judged: input.rows.length === 0 ? 0 : judged.length / input.rows.length,
    findings: [...found.values()].sort(
      (a, b) => a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind)
    )
  }
}

// Below this the sweep looked at too little to say "nothing changed": WhatsApp may have changed how
// its scripts are written, and a clean report would be a false one. The run fails instead.
export const MIN_JUDGED = 0.6

export const coverageOk = (report: SweepReport): boolean => report.judged >= MIN_JUDGED

export const newFindings = (report: SweepReport): Finding[] =>
  report.findings.filter(finding => finding.known === undefined)

// Whether the sweep asks for an issue: a build that is not the verified one and shows something new
export function wantsIssue(report: SweepReport): boolean {
  return report.build !== report.verified && newFindings(report).length > 0
}

const KIND_TEXT: Record<FindingKind, string> = {
  arity: 'the library passes more arguments than the page declares',
  'object-shape': 'the page takes one object, the library passes several arguments',
  'function-missing': 'the module no longer exports a function with that name'
}

const row = (finding: Finding): string =>
  `| \`${finding.target}\` | ${KIND_TEXT[finding.kind]} | ${finding.calls.map(call => `\`${call}\``).join(', ') || '-'} |`

// Names of modules and of functions and places in the library only: no account, session or message data
export function renderReport(report: SweepReport): string {
  const fresh = newFindings(report)
  const known = report.findings.filter(finding => finding.known !== undefined)
  const lines = [
    `WhatsApp Web build \`${report.build}\` (verified build: ${report.verified === undefined ? 'none set' : `\`${report.verified}\``}).`,
    '',
    `The sweep read ${String(report.callsites)} calls of whatsapp-web.js (as patched) to ${String(report.modules)} modules; ${String(report.notJudged)} could not be judged (module that loads on demand, or an export that could not be followed): ${String(Math.round(report.judged * 100))}% judged.`,
    ''
  ]
  const table = (findings: readonly Finding[]): string[] => [
    '| Target | What changed | Called from |',
    '| --- | --- | --- |',
    ...findings.map(row)
  ]
  lines.push(
    fresh.length === 0 ? '**New findings: none.**' : `**New findings: ${String(fresh.length)}.**`,
    ''
  )
  if (fresh.length > 0) lines.push(...table(fresh), '')
  if (known.length > 0) {
    lines.push(
      `Known (already tracked in \`ops/wa-web-sweep-known.json\`): ${String(known.length)}.`,
      '',
      ...table(known),
      ''
    )
  }
  lines.push(
    'The sweep is a text heuristic on an unlinked page: it does not see a change in the type of an argument, and it proves nothing about a linked account. A clean sweep is not a verified build; promotion is a person with the live checks (`docs/operations.md`, "Moving the verified build").'
  )
  return lines.join('\n')
}

export function validateKnown(value: unknown): KnownTarget[] {
  if (!Array.isArray(value)) throw new Error('the known list must be an array')
  const seen = new Set<string>()
  return value.map((entry: unknown, index) => {
    const item =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
    const { target, kind, note } = item
    if (typeof target !== 'string' || !/^[\w$]+\.[\w$]+$/.test(target)) {
      throw new Error(`known[${String(index)}].target must be Module.function`)
    }
    if (kind !== 'arity' && kind !== 'object-shape' && kind !== 'function-missing') {
      throw new Error(
        `known[${String(index)}].kind must be arity, object-shape or function-missing`
      )
    }
    if (typeof note !== 'string' || note.trim() === '') {
      throw new Error(`known[${String(index)}].note must say where it is tracked`)
    }
    if (seen.has(`${target}|${kind}`)) throw new Error(`known[${String(index)}] repeats ${target}`)
    seen.add(`${target}|${kind}`)
    return { target, kind, note }
  })
}
