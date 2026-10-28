import type { EventEnvelope } from '../types/events.js'

import { EventSequencer } from './event-pipeline.sequencer.js'

// The sessions the sequencer still holds a queue for
const tailsOf = (sequencer: EventSequencer): Map<string, unknown> =>
  (sequencer as unknown as { tails: Map<string, unknown> }).tails

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function build(nextSeq?: (sessionId: string) => Promise<number>): {
  sequencer: EventSequencer
  published: EventEnvelope[]
} {
  const counters = new Map<string, number>()
  const published: EventEnvelope[] = []
  const sequencer = new EventSequencer({
    nextSeq:
      nextSeq ??
      (sessionId => {
        const next = (counters.get(sessionId) ?? 0) + 1
        counters.set(sessionId, next)
        return Promise.resolve(next)
      }),
    publish: envelope => published.push(envelope)
  })
  return { sequencer, published }
}

describe('EventSequencer', () => {
  it('stamps an envelope with a unique id, the seq, the session and the time', async () => {
    const { sequencer, published } = build()

    await sequencer.publish('s1', 'ready', {})
    await sequencer.publish('s1', 'ready', {})

    expect(published).toHaveLength(2)
    expect(published[0]).toMatchObject({ event: 'ready', sessionId: 's1', seq: 1, data: {} })
    expect(published[0]?.id).toMatch(/^evt_[0-9a-f-]{36}$/)
    expect(Date.parse(published[0]?.timestamp ?? '')).not.toBeNaN()
    expect(published[1]?.seq).toBe(2)
    expect(published[1]?.id).not.toBe(published[0]?.id)
  })

  it('delivers in seq order even when a stamp takes longer than the next one', async () => {
    let calls = 0
    // The first stamp is the slowest: without the queue it would be published last
    const { sequencer, published } = build(async () => {
      calls += 1
      const seq = calls
      await delay(seq === 1 ? 30 : 1)
      return seq
    })

    await Promise.all([
      sequencer.publish('s1', 'ready', {}),
      sequencer.publish('s1', 'authenticated', {}),
      sequencer.publish('s1', 'ready', {})
    ])

    expect(published.map(envelope => envelope.seq)).toEqual([1, 2, 3])
    expect(published.map(envelope => envelope.event)).toEqual(['ready', 'authenticated', 'ready'])
  })

  it('does not let another event in the middle of a run', async () => {
    const { sequencer, published } = build()

    const batch = sequencer.run('s1', async emit => {
      await emit('ready', {})
      await delay(10)
      await emit('authenticated', {})
    })
    const outsider = sequencer.publish('s1', 'ready', {})
    await Promise.all([batch, outsider])

    expect(published.map(envelope => [envelope.seq, envelope.event])).toEqual([
      [1, 'ready'],
      [2, 'authenticated'],
      [3, 'ready']
    ])
  })

  it('keeps the sessions independent', async () => {
    const { sequencer, published } = build()

    await Promise.all([sequencer.publish('a', 'ready', {}), sequencer.publish('b', 'ready', {})])

    expect(published.map(envelope => [envelope.sessionId, envelope.seq])).toEqual([
      ['a', 1],
      ['b', 1]
    ])
  })

  it('rejects the caller when the seq cannot be assigned and goes on with the next event', async () => {
    let calls = 0
    const { sequencer, published } = build(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('redis down')) : Promise.resolve(calls)
    })

    const failed = sequencer.publish('s1', 'ready', {})
    const next = sequencer.publish('s1', 'ready', {})

    await expect(failed).rejects.toThrow('redis down')
    await next
    expect(published).toHaveLength(1)
    expect(published[0]?.seq).toBe(2)
  })

  it('forgets a session that is idle', async () => {
    const { sequencer } = build()

    await sequencer.publish('s1', 'ready', {})
    await new Promise(resolve => setImmediate(resolve))

    expect(tailsOf(sequencer).size).toBe(0)
  })

  it('forgets a session after a task that failed', async () => {
    const { sequencer } = build()

    await expect(sequencer.run('s1', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    )
    await new Promise(resolve => setImmediate(resolve))

    expect(tailsOf(sequencer).size).toBe(0)
  })

  it('does not forget a session that a newer task is still using', async () => {
    const { sequencer } = build()
    let finish: () => void = () => undefined

    const first = sequencer.run('s1', () => Promise.resolve())
    const second = sequencer.run(
      's1',
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    await first
    await new Promise(resolve => setImmediate(resolve))

    expect(tailsOf(sequencer).size).toBe(1)
    finish()
    await second
  })

  it('rejects the caller, and goes on, when the bus throws', async () => {
    const published: string[] = []
    let fail = true
    const sequencer = new EventSequencer({
      nextSeq: () => Promise.resolve(1),
      publish: envelope => {
        if (fail) throw new Error('bus broke')
        published.push(envelope.event)
      }
    })

    await expect(sequencer.publish('s1', 'ready', {})).rejects.toThrow('bus broke')
    fail = false
    await sequencer.publish('s1', 'ready', {})

    expect(published).toEqual(['ready'])
  })
})
