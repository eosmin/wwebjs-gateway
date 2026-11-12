import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

// The patch in patches/whatsapp-web.js@1.34.8.patch (TDD §2.5) is what makes the library work with
// the current WhatsApp Web. These tests fail when a dependency refresh drops it. The library is
// read as files, not imported: only the adapter may import it.
const libraryRoot = join(process.cwd(), 'node_modules/whatsapp-web.js/src')

describe('the patched whatsapp-web.js', () => {
  const source = (file: string): string => readFileSync(join(libraryRoot, file), 'utf8')

  // 1.34.8 reads the key of a message as `_serialized || $1` everywhere (upstream #201832), which is
  // what our own fallback did in 1.34.7. The patch keeps only the one spot upstream missed, so these
  // tests fail when a refresh brings back a bare `_serialized` read on a key from the page
  it('never reads _serialized from a key inside the page without the $1 fallback', () => {
    const unguarded: Record<string, RegExp[]> = {
      'util/Injected/Utils.js': [
        /newMsgKey\._serialized(?! \|\| )/,
        /\bmsg\.id\._serialized(?! \|\| | == null)/,
        /lastReceivedKey\._serialized(?! \|\| )/
      ],
      'Client.js': [/parentMsgKey\._serialized(?! \|\| )/],
      'structures/Message.js': [/\bmsg\.id\._serialized(?! \|\| )/]
    }

    for (const [file, patterns] of Object.entries(unguarded)) {
      for (const pattern of patterns) expect(source(file)).not.toMatch(pattern)
    }
  })

  // The peer of an incoming call (#42) is the one fallback of ours left in Client.js
  it('keeps the peer fallback of the incoming call hook', () => {
    expect(
      source('Client.js').match(/peer\._serialized \?\? peer\.\$1 \?\? String\(peer\)/g)
    ).toHaveLength(1)
  })

  // `Message.js` edits an event message: the id of the page message has `$1` and may lack `_serialized`
  it('reads the edited event message by its $1 key too', () => {
    expect(source('structures/Message.js')).toMatch(
      /Msg\.get\(\(msg\.id\._serialized \|\| msg\.id\.\$1\)\)/
    )
  })

  // WhatsApp Web loads the module of `createGroup` lazily (F9, upstream PR #201950 is open). The page
  // code cannot run in Jest, so `Client.createGroup` runs here with a fake `window`
  describe('Client.createGroup', () => {
    type CreateGroup = (
      this: unknown,
      title: string,
      participants: string[],
      options: object
    ) => Promise<unknown>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const { prototype } = require(join(libraryRoot, 'Client.js')) as {
      prototype: { createGroup: CreateGroup }
    }
    const created = {
      title: 'g',
      wid: { _serialized: 'g@g.us' },
      participants: [],
      subject: 'g'
    }
    // Runs the function the library hands to `pupPage.evaluate` with `window` replaced
    const create = async (modules: Record<string, unknown>): Promise<unknown> => {
      const target = globalThis as { window?: unknown }
      const before = target.window
      target.window = { require: (name: string) => modules[name], WWebJS: {} }
      try {
        const evaluate = (fn: (...args: unknown[]) => unknown, ...args: unknown[]): unknown =>
          fn(...args)
        return await prototype.createGroup.call({ pupPage: { evaluate } }, 'g', [], {})
      } finally {
        target.window = before
      }
    }

    it('loads the lazy bundle before it asks for the module that creates the group', async () => {
      const modules: Record<string, unknown> = {}
      const requireBundle = jest.fn(() => {
        modules.WAWebGroupCreateJob = { createGroup: () => Promise.resolve(created) }
        return Promise.resolve()
      })
      modules.WAWebNewGroupFlowLoadable = { requireBundle }

      await expect(create(modules)).resolves.toMatchObject({ title: 'g' })
      expect(requireBundle).toHaveBeenCalledTimes(1)
    })

    it('does not load the bundle when the module is already there', async () => {
      const requireBundle = jest.fn()
      const modules = {
        WAWebGroupCreateJob: { createGroup: () => Promise.resolve(created) },
        WAWebNewGroupFlowLoadable: { requireBundle }
      }

      await create(modules)

      expect(requireBundle).not.toHaveBeenCalled()
    })

    it('keeps the cause of a failure in the text it answers, not only the library generic', async () => {
      const modules = {
        WAWebNewGroupFlowLoadable: {
          requireBundle: () => Promise.reject(new Error('bundle offline'))
        }
      }

      const answer = await create(modules)

      expect(answer).toEqual(expect.stringContaining('CreateGroupError'))
      expect(answer).toEqual(expect.stringContaining('bundle offline'))
    })
  })

  // The tests run the real Client.sendMessage with a page we control: the library builds its Message
  // in Node after the page sent, and only a failure there may carry the marker
  describe('Client.sendMessage', () => {
    type SendMessage = (this: unknown, chatId: string, content: string) => Promise<unknown>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const { prototype } = require(join(libraryRoot, 'Client.js')) as {
      prototype: { sendMessage: SendMessage }
    }
    const send = async (answer: () => Promise<unknown>): Promise<unknown> => {
      const evaluate = jest.fn(answer)
      try {
        return await prototype.sendMessage.call({ pupPage: { evaluate } }, 'c@c.us', 'hola')
      } finally {
        // A failure before the page was reached would pass these tests for the wrong reason
        expect(evaluate).toHaveBeenCalledTimes(1)
      }
    }

    it('marks a failure of the Node side after the page sent the message', async () => {
      const unreadable = {
        get id(): never {
          throw new TypeError('x is undefined')
        }
      }

      const error: unknown = await send(() => Promise.resolve(unreadable)).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      expect(error).toHaveProperty('afterDispatch', true)
      expect(error).toHaveProperty('cause', expect.any(TypeError))
    })

    // Puppeteer 24 rejects with the message the page threw, with no prefix (checked against a real
    // Chrome), so the patch tags the start of the message text
    it.each([
      ['plain', '[after-dispatch] message.serialize is not a function'],
      [
        'followed by more lines',
        '[after-dispatch] message.serialize is not a function\n    at eval'
      ]
    ])(
      'marks a failure inside the page once the message was added to the chat, %s',
      async (_name, message) => {
        const rejection = new Error(message)

        const error: unknown = await send(() => Promise.reject(rejection)).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(Error)
        expect(error).toHaveProperty('afterDispatch', true)
        expect(error).toHaveProperty('cause', rejection)
      }
    )

    // A page error before the dispatch can echo what the caller sent (a file name, a quoted id)
    it.each([
      ['the tag in the middle of the text', 'bad file name [after-dispatch] x.png'],
      ['the tag after a line break', 'bad input\n[after-dispatch] a.png'],
      ['the tag behind an error class name', 'Error: [after-dispatch] x'],
      ['an error without a message', '']
    ])('leaves %s unmarked', async (_name, message) => {
      const rejection = new Error(message)

      const error: unknown = await send(() => Promise.reject(rejection)).catch((e: unknown) => e)

      expect(error).toBe(rejection)
    })

    it('answers null, not undefined, when the page found no chat and sent nothing', async () => {
      await expect(send(() => Promise.resolve(null))).resolves.toBeNull()
    })

    it('answers undefined when the page sent but returned no message', async () => {
      await expect(send(() => Promise.resolve(undefined))).resolves.toBeUndefined()
    })

    // The page code cannot run here, so the tags are pinned in the source: one for getMessageModel
    // and one for each branch of WWebJS.sendMessage (chat, channel, status). The in-page code cannot run
    // in Jest: the manual smoke test covers it
    it('tags the page code that runs once the message may have left', () => {
      const count = (file: string): number =>
        (source(file).match(/new Error\('\[after-dispatch\] '/g) ?? []).length

      expect(count('Client.js')).toBe(1)
      expect(count('util/Injected/Utils.js')).toBe(3)
      const utils = source('util/Injected/Utils.js')
      const tagged = /\} catch \(error\) \{\s*throw new Error\('\[after-dispatch\] '/.source
      expect(utils).toMatch(new RegExp(String.raw`updateNewsletterMsgRecord\(msg\);\s*` + tagged))
      expect(utils).toMatch(
        new RegExp(String.raw`\[msg, mediaUpdate\] : \[statusOptions\]\)\);\s*` + tagged)
      )
      expect(utils).toMatch(new RegExp(String.raw`await sendMsgResultPromise;\s*` + tagged))
      expect(source('Client.js')).toMatch(
        /try \{\s*return window\.WWebJS\.getMessageModel\(msg\);\s*\} catch \(error\) \{\s*throw new Error\('\[after-dispatch\] '/
      )
    })

    it('leaves a failure of the page unmarked: the message did not leave', async () => {
      const error: unknown = await send(() =>
        Promise.reject(new Error('Evaluation failed: not a chat'))
      ).catch((e: unknown) => e)

      expect(error).toHaveProperty('message', 'Evaluation failed: not a chat')
      expect(error).not.toHaveProperty('afterDispatch')
    })
  })

  // Probed against a real linked account on WhatsApp Web 2.3000.1052525806 (issue #42): an incoming
  // call reaches `WAWebCallCollection.setActiveCall(call)` and `setActiveCall(null)` ends it. The
  // internal Map the library used to wrap is never written, and `add` / `processIncomingCall` are never
  // called. The page code cannot run in Jest, so the block of Client.js that installs the hook runs here
  // against a fake `window`
  describe('the incoming call hook', () => {
    interface CallModule {
      on?: () => void
      setActiveCall?: (call: unknown, ...rest: unknown[]) => unknown
    }
    const hookSource = (): string => {
      const text = source('Client.js')
      const start = text.indexOf(
        "const WAWebCallCollection = window.require('WAWebCallCollection');"
      )
      const end = text.indexOf("Chat.on('remove'", start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      return text.slice(start, end)
    }
    // The object the probe saw (values redacted)
    const ringing = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'CALL1',
      peerJid: { _serialized: '5210000000000@c.us' },
      offerTime: 1793438493,
      isVideo: false,
      isGroup: false,
      outgoing: false,
      ...overrides
    })
    const install = (
      module: CallModule | undefined,
      onIncomingCall: (call: unknown) => unknown = () => undefined
    ): void => {
      const window = { require: () => module, onIncomingCall }
      // Date and Promise are Jest's, so fake timers reach the block
      runInNewContext(hookSource(), { window, Date, Promise })
    }
    const moduleWith = (inner: jest.Mock = jest.fn((): string => 'original')): CallModule => ({
      on: () => undefined,
      setActiveCall: inner
    })

    it('reports a call that reaches setActiveCall', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())

      expect(onIncomingCall).toHaveBeenCalledTimes(1)
      expect(onIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'CALL1',
          peerJid: '5210000000000@c.us',
          offerTime: 1793438493,
          isVideo: false,
          isGroup: false,
          outgoing: false
        })
      )
    })

    // Seen with a real call: offerTime is 0 while the call rings
    it('stamps a call with the time it arrived when WhatsApp Web has not set offerTime yet', () => {
      jest.useFakeTimers().setSystemTime(new Date(1793438493500))
      try {
        const onIncomingCall = jest.fn()
        const module = moduleWith()
        install(module, onIncomingCall)

        module.setActiveCall?.(ringing({ offerTime: 0 }))

        expect(onIncomingCall).toHaveBeenCalledWith(
          expect.objectContaining({ offerTime: 1793438493 })
        )
      } finally {
        jest.useRealTimers()
      }
    })

    it('keeps a peer id that is already a string', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing({ peerJid: '5210000000000@c.us' }))

      expect(onIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({ peerJid: '5210000000000@c.us' })
      )
    })

    it('reports no peer rather than the text "undefined" when the call has none', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing({ peerJid: undefined }))

      expect(onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({ peerJid: undefined }))
    })

    it('still runs the original setActiveCall with its arguments and answers what it answers', () => {
      const inner = jest.fn((): string => 'original')
      const module = moduleWith(inner)
      install(module)
      const call = ringing()

      const answer = module.setActiveCall?.(call, 'extra')

      expect(inner).toHaveBeenCalledWith(call, 'extra')
      expect(answer).toBe('original')
    })

    it('does not report the end of a call, which is setActiveCall(null)', () => {
      const onIncomingCall = jest.fn()
      const inner = jest.fn()
      const module = moduleWith(inner)
      install(module, onIncomingCall)

      module.setActiveCall?.(null)

      expect(onIncomingCall).not.toHaveBeenCalled()
      expect(inner).toHaveBeenCalledWith(null)
    })

    it('reports a call once, however often WhatsApp Web sets it again', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())
      module.setActiveCall?.(ringing({ isSilenced: true }))
      module.setActiveCall?.(null)
      module.setActiveCall?.(ringing({ id: 'CALL2' }))

      expect(onIncomingCall).toHaveBeenCalledTimes(2)
    })

    it('reports each call once when two calls overlap', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing({ id: 'A' }))
      module.setActiveCall?.(ringing({ id: 'B' }))
      module.setActiveCall?.(ringing({ id: 'A' }))

      expect(onIncomingCall).toHaveBeenCalledTimes(2)
    })

    it('reports a call again on the next setActiveCall when the report failed', async () => {
      const onIncomingCall = jest
        .fn()
        .mockRejectedValueOnce(new Error('binding gone'))
        .mockResolvedValue(undefined)
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())
      await new Promise(resolve => setImmediate(resolve))
      module.setActiveCall?.(ringing())

      expect(onIncomingCall).toHaveBeenCalledTimes(2)
    })

    it('reports a call once even if the block that installs the hook runs twice in the page', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())

      expect(onIncomingCall).toHaveBeenCalledTimes(1)
    })

    it('does not let a failure of the report stop WhatsApp Web setting the call', async () => {
      const inner = jest.fn((): string => 'original')
      const module = moduleWith(inner)
      const onIncomingCall = jest.fn(() => Promise.reject(new Error('binding gone')))
      install(module, onIncomingCall)

      expect(module.setActiveCall?.(ringing())).toBe('original')
      // The hook ran: without this the test would also pass if it was never installed
      expect(onIncomingCall).toHaveBeenCalledTimes(1)
      // A rejection nobody handles would crash the page's event loop of promises
      await new Promise(resolve => setImmediate(resolve))
    })

    it('does nothing when the module is gone or has no setActiveCall', () => {
      expect(() => {
        install(undefined)
      }).not.toThrow()
      expect(() => {
        install({ on: () => undefined })
      }).not.toThrow()
    })
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
