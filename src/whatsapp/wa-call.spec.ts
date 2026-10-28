import { isPuppeteerFailure, notReady, runWaCall } from './wa-call.js'
import { WaDisconnectedError, WaOperationError, WaTimeoutError } from './wa-errors.js'

const never = (): Promise<never> => new Promise<never>(() => undefined)

describe('isPuppeteerFailure', () => {
  it.each([
    'Execution context was destroyed, most likely because of a navigation.',
    'Protocol error (Runtime.callFunctionOn): Target closed.',
    'Protocol error: Connection closed.',
    'Page crashed!',
    'Browser has disconnected!',
    'Browser is not connected',
    "Cannot read properties of null (reading 'goto')",
    'Attempted to use detached Frame',
    'Session closed. Most likely the page has been closed.',
    "Cannot read properties of undefined (reading 'evaluate')",
    'Navigating frame was detached'
  ])('recognizes "%s"', message => {
    expect(isPuppeteerFailure(new Error(message))).toBe(true)
    expect(isPuppeteerFailure(message)).toBe(true)
  })

  it('recognizes a Puppeteer error by its name', () => {
    const error = new Error('anything')
    error.name = 'TargetCloseError'

    expect(isPuppeteerFailure(error)).toBe(true)
  })

  it('does not take a harmless protocol answer for a dead browser', () => {
    const error = new Error('Protocol error (DOM.describeNode): No node with given id found')
    error.name = 'ProtocolError'

    expect(isPuppeteerFailure(error)).toBe(false)
  })

  it.each([new Error('invalid wid'), 'auth timeout', undefined, { message: 'Target closed' }])(
    'does not take %p for a browser failure',
    error => {
      expect(isPuppeteerFailure(error)).toBe(false)
    }
  )
})

describe('runWaCall', () => {
  it('answers what the call answers', async () => {
    await expect(runWaCall('getChats', 1000, () => Promise.resolve(42))).resolves.toBe(42)
  })

  it('turns a dead browser into WaDisconnectedError with the call in flight', async () => {
    const error: unknown = await runWaCall('sendMessage', 1000, () =>
      Promise.reject(new Error('Protocol error: Target closed.'))
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaDisconnectedError)
    expect(error).toMatchObject({ operation: 'sendMessage', dispatched: true })
    // Nothing of the Puppeteer message travels on
    expect((error as Error).message).not.toContain('Protocol')
  })

  it('turns a deadline into WaTimeoutError with the call in flight', async () => {
    const error: unknown = await runWaCall('downloadMedia', 10, never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaTimeoutError)
    expect(error).toMatchObject({ operation: 'downloadMedia', dispatched: true })
  })

  it('turns any other failure, even a thrown string, into WaOperationError', async () => {
    const fromError: unknown = await runWaCall('getChatById', 1000, () =>
      Promise.reject(new Error('Chat not found'))
    ).catch((e: unknown) => e)
    const fromString: unknown = await runWaCall('initialize', 1000, () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- wwebjs throws strings
      Promise.reject('auth timeout')
    ).catch((e: unknown) => e)

    expect(fromError).toBeInstanceOf(WaOperationError)
    expect(fromString).toBeInstanceOf(WaOperationError)
    // Nothing the library said travels on: it can hold chat ids or phone numbers
    expect((fromError as Error).message).toBe('getChatById failed')
    expect((fromString as Error).message).toBe('initialize failed')
  })

  it('gives a failure without a message a message of its own', async () => {
    const error: unknown = await runWaCall('getChats', 1000, () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- wwebjs rejects with nothing
      Promise.reject(undefined)
    ).catch((e: unknown) => e)

    expect((error as Error).message).toBe('getChats failed')
  })

  it('hands the original failure to onFailure so the caller can log what is safe', async () => {
    const original = new Error('Chat 5215500000001@c.us not found')
    const seen: unknown[] = []

    const error: unknown = await runWaCall(
      'getChatById',
      1000,
      () => Promise.reject(original),
      failure => seen.push(failure)
    ).catch((e: unknown) => e)

    expect(seen).toEqual([original])
    expect((error as Error).message).not.toContain('5215500000001')
  })

  it('translates a call that throws before it returns a promise', async () => {
    const error: unknown = await runWaCall('getChats', 1000, () => {
      throw new Error("Cannot read properties of undefined (reading 'evaluate')")
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WaDisconnectedError)
  })

  it.each([
    new WaDisconnectedError('x', false),
    new WaTimeoutError('x', true),
    new WaOperationError('x', 'Message not found')
  ])('lets a typed error through untouched: %p', async original => {
    await expect(runWaCall('x', 1000, () => Promise.reject(original))).rejects.toBe(original)
  })

  it('leaves no unhandled rejection when the call fails after the deadline', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let fail: (reason: Error) => void = () => undefined
      const late = new Promise<never>((_resolve, reject) => {
        fail = reject
      })

      await expect(runWaCall('slow', 10, () => late)).rejects.toBeInstanceOf(WaTimeoutError)
      fail(new Error('Target closed'))
      await new Promise(resolve => setTimeout(resolve, 20))

      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('notReady', () => {
  it('says the call never left', () => {
    const error = notReady('sendMessage')

    expect(error).toBeInstanceOf(WaDisconnectedError)
    expect(error).toMatchObject({ operation: 'sendMessage', dispatched: false })
  })
})
