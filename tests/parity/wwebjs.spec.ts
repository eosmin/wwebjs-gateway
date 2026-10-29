import { readWwebjsSymbols } from '../../scripts/lib/wwebjs-symbols.js'
import { AppModule } from '../../src/app.module.js'
import { collectOperations } from '../../src/parity/operation-links.js'
import { UNSUPPORTED_SYMBOLS } from '../../src/parity/overrides.js'
import { WA_EVENT_NAMES } from '../../src/types/events.js'

import { EXPECTED_FAILURES } from './expected-failures.js'

const symbols = new Set(readWwebjsSymbols())
let linked = new Set<string>()
const events = new Set(WA_EVENT_NAMES.map(name => `Events.${name}`))

beforeAll(async () => {
  linked = new Set((await collectOperations(AppModule)).flatMap(operation => operation.wwebjs))
})

const isCovered = (symbol: string): boolean =>
  linked.has(symbol) || events.has(symbol) || symbol in UNSUPPORTED_SYMBOLS

const libraryEvents = [...symbols].filter(symbol => symbol.startsWith('Events.'))

describe('whatsapp-web.js parity', () => {
  it('has a reason for every unsupported symbol', () => {
    const withoutReason = Object.entries(UNSUPPORTED_SYMBOLS)
      .filter(([, reason]) => !/^(security|internal): \S.{8,}/.test(reason))
      .map(([symbol]) => symbol)
    expect(withoutReason).toEqual([])
  })

  it('does not mark unsupported a symbol an operation links or an event covers', () => {
    const both = Object.keys(UNSUPPORTED_SYMBOLS).filter(
      symbol => linked.has(symbol) || events.has(symbol)
    )
    expect(both).toEqual([])
  })

  it('does not link, or mark unsupported, a symbol the library does not declare', () => {
    const unknown = [...linked, ...Object.keys(UNSUPPORTED_SYMBOLS)].filter(
      symbol => !symbols.has(symbol)
    )
    expect(unknown).toEqual([])
  })

  it('names every event the library emits in WA_EVENT_NAMES', () => {
    expect(libraryEvents.filter(symbol => !events.has(symbol))).toEqual([])
  })

  describe('expected failures', () => {
    // Field-only symbols (DTO fields, TDD §6.12 source d) stay here until that source exists
    const uncovered = (): string[] => [...symbols].filter(symbol => !isCovered(symbol))

    it('is sorted and has no repeat', () => {
      expect([...EXPECTED_FAILURES]).toEqual([...new Set(EXPECTED_FAILURES)].sort())
    })

    it('lists no symbol the library does not declare', () => {
      expect(EXPECTED_FAILURES.filter(symbol => !symbols.has(symbol))).toEqual([])
    })

    // A new symbol must be mapped or marked unsupported
    it('covers every symbol that is not listed', () => {
      const listed = new Set(EXPECTED_FAILURES)
      expect(uncovered().filter(symbol => !listed.has(symbol))).toEqual([])
    })

    // The list only shrinks, and it is empty by Phase 9
    it('lists only symbols that are still uncovered', () => {
      const stillUncovered = new Set(uncovered())
      expect(EXPECTED_FAILURES.filter(symbol => !stillUncovered.has(symbol))).toEqual([])
    })
  })
})
