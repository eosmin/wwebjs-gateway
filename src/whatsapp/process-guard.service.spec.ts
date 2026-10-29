import { Logger } from '@nestjs/common'

import { ProcessGuardService } from './process-guard.service.js'
import type { WatchdogService } from './watchdog.service.js'

type Listener = (reason: unknown) => void

function build(check: () => Promise<void> = () => Promise.resolve()) {
  const watchdog = { check: jest.fn(check) }
  const guard = new ProcessGuardService(watchdog as unknown as WatchdogService)
  return { guard, watchdog }
}

// What `process.on` was given for an event, without letting Jest's own listeners be replaced
function installed(on: jest.SpyInstance, event: string): Listener {
  const call = on.mock.calls.find(([name]) => name === event) as [string, Listener] | undefined
  if (call === undefined) throw new Error(`no ${event} listener was installed`)
  return call[1]
}

let on: jest.SpyInstance
let off: jest.SpyInstance
let exit: jest.SpyInstance
let fatal: jest.SpyInstance
let warn: jest.SpyInstance

beforeEach(() => {
  on = jest.spyOn(process, 'on').mockImplementation(() => process)
  off = jest.spyOn(process, 'off').mockImplementation(() => process)
  exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never)
  fatal = jest.spyOn(Logger.prototype, 'fatal').mockImplementation()
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
  jest.spyOn(Logger.prototype, 'error').mockImplementation()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('ProcessGuardService', () => {
  it('installs the two listeners at bootstrap and removes the same ones at the end of the shutdown', () => {
    const { guard } = build()

    guard.onApplicationBootstrap()
    const rejection = installed(on, 'unhandledRejection')
    const exception = installed(on, 'uncaughtException')
    guard.onApplicationShutdown()

    expect(off).toHaveBeenCalledWith('unhandledRejection', rejection)
    expect(off).toHaveBeenCalledWith('uncaughtException', exception)
  })

  describe.each(['unhandledRejection', 'uncaughtException'])('on %s', event => {
    function raise(guard: ProcessGuardService, reason: unknown): void {
      guard.onApplicationBootstrap()
      installed(on, event)(reason)
    }

    it.each([
      [
        'an error',
        new Error('Execution context was destroyed, most likely because of a navigation.')
      ],
      ['a string', 'Target closed']
    ])(
      'checks every session and keeps the process up for a browser failure given as %s',
      (_kind, reason) => {
        const { guard, watchdog } = build()

        raise(guard, reason)

        expect(watchdog.check).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(event))
        expect(exit).not.toHaveBeenCalled()
        expect(fatal).not.toHaveBeenCalled()
      }
    )

    it('does not put the message of the failure in the warning', () => {
      const { guard } = build()

      raise(guard, new Error('Target closed while reading +5215512345678'))

      expect(JSON.stringify(warn.mock.calls)).not.toContain('5215512345678')
    })

    it('survives a check that fails to run', async () => {
      const { guard } = build(() => Promise.reject(new Error('boom')))

      raise(guard, 'Target closed')
      await new Promise(resolve => setImmediate(resolve))

      expect(exit).not.toHaveBeenCalled()
    })

    it('logs fatal with the name and the frames, never the message, and exits non-zero for anything else', () => {
      const { guard, watchdog } = build()
      const bug = new TypeError('x is not a function for +5215512345678')

      raise(guard, bug)

      const [logged, context] = fatal.mock.calls[0] as [string, string]
      expect(logged).toContain('TypeError')
      expect(logged).toContain('process-guard.service.spec')
      expect(logged).not.toContain('5215512345678')
      expect(context).toBe(event)
      expect(exit).toHaveBeenCalledWith(1)
      expect(watchdog.check).not.toHaveBeenCalled()
    })

    it('exits for a rejection that is not an error', () => {
      const { guard } = build()

      raise(guard, { code: 42 })

      expect(fatal).toHaveBeenCalledWith('a object was thrown, not an Error', event)
      expect(exit).toHaveBeenCalledWith(1)
    })
  })
})
