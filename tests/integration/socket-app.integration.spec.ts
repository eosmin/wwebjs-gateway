import { SocketApp, until } from '../helpers/socket-app.js'

// The socket gateway inside the REAL application: every global guard, pipe, interceptor and filter of
// AppModule runs on its messages, which the gateway spec (a hand-built module) never mounts. A global
// component that assumes an HTTP request breaks every socket message with an exception the client
// sees as no acknowledgement at all.
describe('Socket.IO gateway in the whole application (integration)', () => {
  const harness = new SocketApp()
  let sessionKey = ''
  let eventsOnlyKey = ''

  beforeAll(async () => {
    await harness.boot({ RATE_LIMIT_MAX: '100000' })
    await harness.startSessions()
    sessionKey = await harness.createKey('socket session key', ['read', 'send', 'manage', 'events'])
    eventsOnlyKey = await harness.createKey('socket events key', ['events'])
  })

  afterAll(() => harness.shutdown())

  beforeEach(() => harness.watchExceptions())

  afterEach(() => harness.stopWatching())

  it('acknowledges subscribe, a command, replay and unsubscribe, and throws nothing in the exception layer', async () => {
    const socket = await harness.connected(sessionKey)
    const failures: unknown[] = []
    socket.on('exception', failure => failures.push(failure))
    const received: { event: string }[] = []
    socket.on('wa:event', envelope => received.push(envelope as { event: string }))

    const subscribed = await harness.send(socket, 'subscribe', { sessionId: harness.id })
    harness.client().emit({ event: 'change_state', data: { state: 'CONNECTED' } })
    await until(() => received.some(envelope => envelope.event === 'change_state'))
    const read = await harness.command(socket, 'session.get')
    const replayed = await harness.send(socket, 'replay', { sessionId: harness.id, afterSeq: 0 })
    const unsubscribed = await harness.send(socket, 'unsubscribe', { sessionId: harness.id })

    expect(subscribed).toMatchObject({ ok: true, snapshot: { status: 'ready' } })
    expect(read).toMatchObject({ ok: true, data: { id: harness.id, status: 'ready' } })
    expect(replayed).toMatchObject({ ok: true })
    expect(unsubscribed).toEqual({ ok: true })
    expect(failures).toEqual([])
    expect(harness.exceptionsLogged()).toEqual([])
  })

  it('keeps the checks of the handshake and of the commands that the HTTP guards do not run', async () => {
    const refused = await harness.connect('wgk_not_a_key')
    const missing = await harness.connect(undefined)
    const socket = await harness.connected(sessionKey)
    const limited = await harness.connected(eventsOnlyKey)

    const foreign = await harness.send(socket, 'subscribe', { sessionId: harness.other })
    const everything = await harness.send(socket, 'subscribe', { sessionId: '*' })
    const foreignCommand = await harness.command(socket, 'session.get', {
      sessionId: harness.other
    })
    const noScope = await harness.command(limited, 'session.get')
    const unknown = await harness.command(socket, 'sessions.create')

    expect(refused.error?.data?.code).toBe('UNAUTHORIZED')
    expect(missing.error?.data?.code).toBe('UNAUTHORIZED')
    expect(foreign).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(everything).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(foreignCommand).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(noScope).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_SCOPE' } })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(harness.exceptionsLogged()).toEqual([])
  })
})
