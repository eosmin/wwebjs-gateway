import { type Ack, SocketApp } from '../helpers/socket-app.js'

// Its own file: the limit is read from the environment when the application module loads, so a second
// application with another RATE_LIMIT_MAX needs a fresh module registry.
describe('Socket.IO limits in the whole application (integration)', () => {
  const harness = new SocketApp()
  let sessionKey = ''

  beforeAll(async () => {
    await harness.boot({ RATE_LIMIT_MAX: '5' })
    // One REST call of set-up: each one counts against the buckets of the HTTP guard, which hold 5
    sessionKey = await harness.createKey('socket limited key', ['read', 'events'], null)
  })

  afterAll(() => harness.shutdown())

  beforeEach(() => harness.watchExceptions())

  afterEach(() => harness.stopWatching())

  it('limits the commands of a key and the failed handshakes of an address in the gateway itself', async () => {
    const socket = await harness.connected(sessionKey)

    const answers: Ack[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) {
      answers.push(await harness.command(socket, 'session.get', { sessionId: harness.id }))
    }
    const failed: (string | undefined)[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) {
      failed.push((await harness.connect('wgk_not_a_key')).error?.data?.code)
    }

    // The session does not exist: the command fails, but it is counted and acknowledged all the same
    expect(answers.slice(0, 5).every(answer => answer.error?.code !== 'RATE_LIMITED')).toBe(true)
    expect(answers.slice(5).map(answer => answer.error?.code)).toEqual([
      'RATE_LIMITED',
      'RATE_LIMITED'
    ])
    expect(failed.slice(0, 5)).toEqual(Array(5).fill('UNAUTHORIZED'))
    expect(failed.slice(5)).toEqual(['RATE_LIMITED', 'RATE_LIMITED'])
    expect(harness.exceptionsLogged()).toEqual([])
  })
})
