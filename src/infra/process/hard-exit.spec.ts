import { Logger } from '@nestjs/common'

import { HARD_EXIT_MS, armHardExit } from './hard-exit.js'

describe('armHardExit', () => {
  let once: jest.SpyInstance
  let exit: jest.SpyInstance
  let fatal: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    once = jest.spyOn(process, 'once').mockImplementation(() => process)
    fatal = jest.spyOn(Logger.prototype, 'fatal').mockImplementation()
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  const handlerFor = (signal: string): (() => void) => {
    const call = once.mock.calls.find(([name]) => name === signal) as
      [string, () => void] | undefined
    if (call === undefined) throw new Error(`no ${signal} handler`)
    return call[1]
  }

  it('does nothing until a stop signal arrives', () => {
    armHardExit()

    jest.advanceTimersByTime(HARD_EXIT_MS * 2)

    expect(exit).not.toHaveBeenCalled()
  })

  it.each(['SIGTERM', 'SIGINT'])(
    'exits non-zero when the shutdown after %s takes too long',
    signal => {
      armHardExit()

      handlerFor(signal)()
      jest.advanceTimersByTime(HARD_EXIT_MS - 1)
      expect(exit).not.toHaveBeenCalled()
      jest.advanceTimersByTime(1)

      expect(exit).toHaveBeenCalledWith(1)
    }
  )

  it('starts one clock when both signals arrive', () => {
    armHardExit()

    handlerFor('SIGTERM')()
    handlerFor('SIGINT')()
    jest.advanceTimersByTime(HARD_EXIT_MS)

    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('says why before it exits', () => {
    armHardExit()

    handlerFor('SIGTERM')()
    jest.advanceTimersByTime(HARD_EXIT_MS)

    expect(fatal).toHaveBeenCalledWith(expect.stringContaining('30 s'))
  })
})
