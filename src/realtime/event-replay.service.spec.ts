import { TEST_ENV } from '../../tests/helpers/env.js'
import { parseEnv } from '../config/env.schema.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { RedisService } from '../infra/redis/redis.service.js'
import type { EventEnvelope } from '../types/events.js'
import { EventBusService } from '../whatsapp/event-bus.service.js'

import { EventReplayService, REPLAY_MAX_EVENT_BYTES } from './event-replay.service.js'

const envelope = (data: unknown = { id: 'm1' }): EventEnvelope =>
  ({
    id: 'evt_1',
    event: 'message',
    sessionId: 'sales',
    seq: 1,
    timestamp: new Date().toISOString(),
    data
  }) as EventEnvelope

describe('EventReplayService (failure paths)', () => {
  const client = {
    xadd: jest.fn<Promise<string | null>, unknown[]>(),
    xrange: jest.fn<Promise<[string, string[]][]>, unknown[]>(),
    xtrim: jest.fn(),
    pexpire: jest.fn<Promise<number>, unknown[]>(),
    del: jest.fn<Promise<number>, unknown[]>(),
    get: jest.fn<Promise<string | null>, unknown[]>()
  }
  let metrics: MetricsService
  let replay: EventReplayService

  beforeEach(() => {
    for (const fn of Object.values(client)) fn.mockReset()
    client.pexpire.mockResolvedValue(1)
    metrics = new MetricsService()
    replay = new EventReplayService(
      parseEnv(TEST_ENV),
      { client } as unknown as RedisService,
      new EventBusService(),
      metrics
    )
  })

  it('never rejects when Redis fails: it counts the failure and logs no content', async () => {
    client.xadd.mockRejectedValue(new Error('connection lost: secret body'))

    await expect(replay.record(envelope({ body: 'secret body' }))).resolves.toBeUndefined()

    expect(await metrics.scrape()).toMatch(/gw_replay_write_failures_total 1\b/)
  })

  it('does not keep an event over the size limit', async () => {
    await replay.record(envelope({ body: 'x'.repeat(REPLAY_MAX_EVENT_BYTES) }))

    expect(client.xadd).not.toHaveBeenCalled()
    expect(await metrics.scrape()).toMatch(/gw_replay_write_failures_total 1\b/)
  })

  it('answers INTERNAL, hiding the cause, when the replay cannot be read', async () => {
    client.xrange.mockRejectedValue(new Error('READONLY'))

    await expect(replay.read('sales', 0, 10)).rejects.toMatchObject({ code: 'INTERNAL' })
    client.get.mockRejectedValue(new Error('down'))
    await expect(replay.lastSeq('sales')).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('skips an entry that is not an envelope instead of failing the whole read', async () => {
    client.xrange.mockResolvedValue([
      ['1-0', ['e', 'not json']],
      ['2-0', ['e', JSON.stringify(envelope())]],
      ['3-0', ['other', 'x']]
    ])

    const page = await replay.read('sales', 0, 10)

    expect(page.events.map(e => e.id)).toEqual(['evt_1'])
  })

  it('treats a seq it cannot read as 0', async () => {
    client.get.mockResolvedValue('not a number')

    expect(await replay.lastSeq('sales')).toBe(0)
  })

  it('keeps going when the sweep of one session fails', async () => {
    client.xadd.mockResolvedValue('1-0')
    await replay.record(envelope())
    client.xrange.mockRejectedValue(new Error('down'))

    await expect(replay.sweep()).resolves.toBeUndefined()
  })
})
