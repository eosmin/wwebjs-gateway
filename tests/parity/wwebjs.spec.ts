import { readWwebjsSymbols } from '../../scripts/lib/wwebjs-symbols.js'
import { AppModule } from '../../src/app.module.js'
import { brokenFieldEntries, FIELD_OWNERS, isFieldLinked } from '../../src/parity/field-links.js'
import { collectOperations } from '../../src/parity/operation-links.js'
import { UNSUPPORTED_SYMBOLS } from '../../src/parity/overrides.js'
import { WA_EVENT_NAMES } from '../../src/types/events.js'

const symbols = new Set(readWwebjsSymbols())
let linked = new Set<string>()
const events = new Set(WA_EVENT_NAMES.map(name => `Events.${name}`))

beforeAll(async () => {
  linked = new Set((await collectOperations(AppModule)).flatMap(operation => operation.wwebjs))
})

// A symbol is covered by an operation, an event, a field of a DTO, a body or the environment, or it is
// unsupported with a reason (TDD §6.12)
const isCovered = (symbol: string): boolean =>
  linked.has(symbol) || events.has(symbol) || isFieldLinked(symbol) || symbol in UNSUPPORTED_SYMBOLS

const libraryEvents = [...symbols].filter(symbol => symbol.startsWith('Events.'))

describe('whatsapp-web.js parity', () => {
  it('has a reason for every unsupported symbol', () => {
    const withoutReason = Object.entries(UNSUPPORTED_SYMBOLS)
      .filter(([, reason]) => !/^(security|internal): \S.{8,}/.test(reason))
      .map(([symbol]) => symbol)
    expect(withoutReason).toEqual([])
  })

  it('does not mark unsupported a symbol an operation, an event or a field covers', () => {
    const both = Object.keys(UNSUPPORTED_SYMBOLS).filter(
      symbol => linked.has(symbol) || events.has(symbol) || isFieldLinked(symbol)
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

  describe('fields', () => {
    it('has an owner the library declares for every field table', () => {
      const owners = new Set([...symbols].map(symbol => symbol.split('.')[0]))
      expect(Object.keys(FIELD_OWNERS).filter(owner => !owners.has(owner))).toEqual([])
    })

    it('names only members the library declares in its renames and skips', () => {
      const stale = Object.entries(FIELD_OWNERS).flatMap(([owner, sources]) =>
        sources.flatMap(({ renames = {}, skip = [] }) =>
          [...Object.keys(renames), ...skip]
            .filter(member => !symbols.has(`${owner}.${member}`))
            .map(member => `${owner}.${member}`)
        )
      )
      expect(stale).toEqual([])
    })

    it('points every rename at a field that exists', () => {
      expect(brokenFieldEntries()).toEqual([])
    })
  })

  // The expected-failures list of the earlier phases is gone: every symbol is covered. A new symbol
  // that a library upgrade brings must be mapped or marked unsupported, so it fails here first.
  it('covers every symbol of the library', () => {
    expect([...symbols].filter(symbol => !isCovered(symbol))).toEqual([])
  })
})
