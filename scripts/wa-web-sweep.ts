import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, env, exit } from 'node:process'

import { launch } from 'puppeteer-core'

import {
  analyzeCalls,
  buildReport,
  coverageOk,
  extractFactories,
  findCallsites,
  isBuild,
  renderReport,
  validateKnown,
  wantsIssue,
  type PageCheck,
  type SourceFile
} from './lib/wa-web-sweep.js'

// The signature sweep of WhatsApp Web (plan 10.11, INV-wa-web-pin). Opens web.whatsapp.com in a throwaway
// browser profile WITHOUT an account: it stays on the QR screen, never scans, never stores a login. It
// reads the build and the factory of every module whatsapp-web.js calls, compares them with the calls of
// the library as patched, and writes report.json and report.md. The scripts of WhatsApp are kept in
// memory only: nothing of the page is saved.
//
//   CHROME_PATH=/usr/bin/google-chrome pnpm wa-web:sweep [--out <dir>]

const LIBRARY_SOURCE = 'node_modules/whatsapp-web.js/src'
const PAGE_URL = 'https://web.whatsapp.com'
const SCRIPT_URL = /^https:\/\/static\.whatsapp\.net\/.*\.js(\?|$)/
// The page rejects the old user agent of the library, so the sweep presents a recent desktop Chrome
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const READY_TIMEOUT_MS = 90_000
// Scripts that load on demand come in after the first paint
const SETTLE_MS = 15_000

function readSources(root: string, prefix = ''): SourceFile[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name)
    const relative = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(path).isDirectory()) return readSources(path, relative)
    return name.endsWith('.js')
      ? [{ file: `src/${relative}`, text: readFileSync(path, 'utf8') }]
      : []
  })
}

function outputDirectory(): string {
  const at = argv.indexOf('--out')
  return at === -1 ? 'sweep-out' : (argv[at + 1] ?? 'sweep-out')
}

// What runs inside the page is plain JavaScript in a string: the TypeScript runner would add helpers
// (`__name`) to a function, and the page does not have them
const PAGE_READY =
  "typeof window.require === 'function' && window.require('WAWebWidFactory') != null"
const PAGE_CHECK = `function (names) {
  var notLoaded = [], notFunction = [];
  names.forEach(function (target) {
    var cut = target.lastIndexOf('.'), mod = target.slice(0, cut), fn = target.slice(cut + 1), exported;
    try { exported = window.require(mod); } catch (error) { notLoaded.push(target); return; }
    if (exported == null) notLoaded.push(target);
    else if (typeof exported[fn] !== 'function') notFunction.push(target);
  });
  var version = window.Debug && window.Debug.VERSION;
  return { build: typeof version === 'string' ? version : '', notLoaded: notLoaded, notFunction: notFunction };
}`

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

function readPageCheck(value: unknown): PageCheck {
  const item = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const { build, notLoaded, notFunction } = item
  if (typeof build !== 'string' || !isStrings(notLoaded) || !isStrings(notFunction)) {
    throw new Error('the page answered something the sweep does not understand')
  }
  return { build, notLoaded, notFunction }
}

async function main(): Promise<void> {
  const chrome = env['CHROME_PATH']
  if (chrome === undefined || chrome === '') throw new Error('CHROME_PATH is not set')

  const verifiedText = readFileSync('ops/wa-web-verified-build.txt', 'utf8').trim()
  const verified = isBuild(verifiedText) ? verifiedText : undefined
  const known = validateKnown(JSON.parse(readFileSync('ops/wa-web-sweep-known.json', 'utf8')))

  const calls = findCallsites(readSources(LIBRARY_SOURCE))
  const modules = new Set(calls.map(call => call.mod))
  const targets = [...new Set(calls.map(call => `${call.mod}.${call.fn}`))]
  console.log(`${String(calls.length)} calls, ${String(modules.size)} modules in the library`)

  const profile = mkdtempSync(join(tmpdir(), 'wa-web-sweep-'))
  const browser = await launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
    // The runner has no user namespace for the sandbox of Chrome; the profile is empty and the page
    // gets no account
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  })
  try {
    const page = await browser.newPage()
    await page.setUserAgent(USER_AGENT)
    const bundles: Promise<string>[] = []
    page.on('response', response => {
      if (SCRIPT_URL.test(response.url())) bundles.push(response.text().catch(() => ''))
    })
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS })
    // Polled from here: the page forbids eval, which `waitForFunction` with a string would need
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (!(await page.evaluate(PAGE_READY).catch(() => false))) {
      if (Date.now() > deadline) throw new Error('the page did not expose its modules in time')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS))

    const check = readPageCheck(await page.evaluate(`(${PAGE_CHECK})(${JSON.stringify(targets)})`))
    if (!isBuild(check.build))
      throw new Error('the page did not answer a build of the form 2.3000.<number>')
    const texts = await Promise.all(bundles)
    console.log(
      `${String(texts.length)} scripts, ${String(texts.filter(text => text === '').length)} unreadable`
    )
    const factories = extractFactories(texts, modules)
    // A target whose module is registered but whose function is absent is a finding; one whose module
    // is not loaded yet is not judged
    const report = buildReport({
      rows: analyzeCalls(calls, factories),
      page: check,
      known,
      verified
    })

    if (!coverageOk(report)) {
      throw new Error(
        `the sweep could judge only ${String(Math.round(report.judged * 100))}% of the calls: WhatsApp may have changed how its scripts are written`
      )
    }
    const out = outputDirectory()
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'report.json'),
      `${JSON.stringify({ ...report, issue: wantsIssue(report) }, null, 2)}\n`
    )
    writeFileSync(join(out, 'report.md'), `${renderReport(report)}\n`)
    console.log(
      `build ${report.build}: ${String(report.findings.length)} findings, issue: ${String(wantsIssue(report))}`
    )
  } finally {
    await browser.close()
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'the sweep failed')
  exit(1)
})
