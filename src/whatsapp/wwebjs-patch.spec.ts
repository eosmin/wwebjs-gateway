import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The patch in patches/whatsapp-web.js@1.34.7.patch (TDD §2.5) is what makes the library work with
// the current WhatsApp Web. These tests fail when a dependency refresh drops it. The library is
// read as files, not imported: only the adapter may import it.
const libraryRoot = join(process.cwd(), 'node_modules/whatsapp-web.js/src')

describe('the patched whatsapp-web.js', () => {
  const source = (file: string): string => readFileSync(join(libraryRoot, file), 'utf8')

  // `Client.getPollVotes` still reads `msg.id._serialized`: that message was built in Node, where the
  // patch put `_serialized` back
  it('never reads _serialized from a key inside the page without a fallback', () => {
    const unguarded: Record<string, RegExp[]> = {
      'util/Injected/Utils.js': [
        /newMsgKey\._serialized(?! \?\?)/,
        /\bmsg\.id\._serialized(?! \?\?)/,
        /lastReceivedKey\._serialized(?! \?\?)/
      ],
      'Client.js': [/parentMsgKey\._serialized(?! \?\?)/],
      'structures/Message.js': [/\bmsg\.id\._serialized(?! \?\?)/]
    }

    for (const [file, patterns] of Object.entries(unguarded)) {
      for (const pattern of patterns) expect(source(file)).not.toMatch(pattern)
    }
  })

  // The copy of the key must not depend on `remote` being an object: a key whose `remote` is
  // already a string would reach Node without `_serialized` too
  it('keeps _serialized on the message id it copies out of the page, whatever its remote', () => {
    expect(source('util/Injected/Utils.js')).toMatch(
      /msg\.id = Object\.assign\(\{\}, msg\.id, \{\s*\.\.\.\(typeof msg\.id\.remote === 'object'\s*\? \{ remote: msg\.id\.remote\._serialized \}\s*: \{\}\),\s*_serialized: \(msg\.id\._serialized \?\? String\(msg\.id\)\),\s*\}\);/
    )
  })

  // Coarse tripwire next to the per-site patterns above: a dependency refresh that renames the
  // key variables would slip past them but not past the count of fallbacks the patch wrote
  it('carries every fallback the patch writes', () => {
    const fallbacks = (file: string): number =>
      (source(file).match(/_serialized \?\? String\(/g) ?? []).length

    expect(fallbacks('util/Injected/Utils.js')).toBe(5)
    expect(fallbacks('Client.js')).toBe(2)
    expect(fallbacks('structures/Message.js')).toBe(1)
  })

  describe('exposeFunctionIfAbsent', () => {
    type Helper = (page: FakePage, name: string, fn: () => void) => Promise<void>
    interface FakePage {
      evaluate: jest.Mock<Promise<boolean>, []>
      exposeFunction: jest.Mock<Promise<void>, []>
    }
    // Loaded by path: only the adapter may import the library by name
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its helper
    const { exposeFunctionIfAbsent } = require(join(libraryRoot, 'util/Puppeteer.js')) as {
      exposeFunctionIfAbsent: Helper
    }

    const pageWhere = (exposeFunction: FakePage['exposeFunction']): FakePage => ({
      evaluate: jest.fn<Promise<boolean>, []>().mockResolvedValue(false),
      exposeFunction
    })

    it('retries when a short-lived frame closes in the middle of the call', async () => {
      const exposeFunction = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error('Protocol error (Runtime.addBinding): Target closed'))
        .mockResolvedValueOnce(undefined)
      const page = pageWhere(exposeFunction)

      await exposeFunctionIfAbsent(page, 'onReady', () => undefined)

      expect(exposeFunction).toHaveBeenCalledTimes(2)
    })

    it('stops at once when the binding turned out to be there after the failed call', async () => {
      const exposeFunction = jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(new Error('Protocol error (Runtime.addBinding): Target closed'))
      const page = pageWhere(exposeFunction)
      page.evaluate.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

      await exposeFunctionIfAbsent(page, 'onReady', () => undefined)

      expect(exposeFunction).toHaveBeenCalledTimes(1)
    })

    it('does not expose anything when the binding is already there', async () => {
      const exposeFunction = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
      const page = pageWhere(exposeFunction)
      page.evaluate.mockResolvedValue(true)

      await exposeFunctionIfAbsent(page, 'onReady', () => undefined)

      expect(exposeFunction).not.toHaveBeenCalled()
    })

    it('passes on a rejection that carries no message', async () => {
      const exposeFunction = jest.fn<Promise<void>, []>().mockRejectedValue(undefined)

      await expect(
        exposeFunctionIfAbsent(pageWhere(exposeFunction), 'a', () => undefined)
      ).rejects.toBeUndefined()
      expect(exposeFunction).toHaveBeenCalledTimes(1)
    })

    it('gives up after five attempts and passes any other error on at once', async () => {
      const closed = jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(new Error('Protocol error: Target closed'))
      await expect(exposeFunctionIfAbsent(pageWhere(closed), 'a', () => undefined)).rejects.toThrow(
        'Target closed'
      )
      expect(closed).toHaveBeenCalledTimes(5)

      const other = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('boom'))
      await expect(exposeFunctionIfAbsent(pageWhere(other), 'a', () => undefined)).rejects.toThrow(
        'boom'
      )
      expect(other).toHaveBeenCalledTimes(1)
    })
  })
})
