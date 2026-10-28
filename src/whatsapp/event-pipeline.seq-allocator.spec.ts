import { Logger } from '@nestjs/common'

import { SEQ_BLOCK_SIZE, SEQ_RETRY_MS, SeqAllocator } from './event-pipeline.seq-allocator.js'

const ID = 'support-line'

// Redis and the database in memory; `lose` is a Redis that forgot its increments and `restart` a
// new gateway process over the same Redis and database
function build(reserved = 0): {
  allocator: SeqAllocator
  redis: { value: number }
  db: { reserved: number }
  saves: number[]
  lose: (value?: number) => void
  restart: () => SeqAllocator
} {
  const redis = { value: 0 }
  const db = { reserved }
  const saves: number[] = []
  const create = (): SeqAllocator =>
    new SeqAllocator({
      increment: () => Promise.resolve(++redis.value),
      set: (_id, value) => {
        redis.value = value
        return Promise.resolve()
      },
      loadReserved: () => Promise.resolve(db.reserved),
      raiseReserved: (_id, value) => {
        saves.push(value)
        db.reserved = Math.max(db.reserved, value)
        return Promise.resolve()
      },
      setReserved: (_id, value) => {
        saves.push(value)
        db.reserved = value
        return Promise.resolve()
      }
    })
  return {
    allocator: create(),
    redis,
    db,
    saves,
    lose: (value = 0) => {
      redis.value = value
    },
    restart: create
  }
}

const take = async (allocator: SeqAllocator, count: number): Promise<number[]> => {
  const out: number[] = []
  for (let n = 0; n < count; n++) out.push(await allocator.next(ID))
  return out
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('SeqAllocator', () => {
  it('counts from 1 for a session that never delivered', async () => {
    const { allocator } = build()
    expect(await take(allocator, 3)).toEqual([1, 2, 3])
  })

  it('reserves a block before the first seq above the bound is used', async () => {
    const { allocator, saves, db } = build()
    await take(allocator, 1)
    expect(saves).toEqual([SEQ_BLOCK_SIZE])
    expect(db.reserved).toBe(SEQ_BLOCK_SIZE)

    await take(allocator, SEQ_BLOCK_SIZE - 1)
    expect(saves).toEqual([SEQ_BLOCK_SIZE])
    await take(allocator, 1)
    expect(saves).toEqual([SEQ_BLOCK_SIZE, 2 * SEQ_BLOCK_SIZE])
  })

  it('starts above the bound after a restart whose Redis forgot the counter', async () => {
    const { allocator } = build(250)
    expect(await take(allocator, 2)).toEqual([251, 252])
  })

  it('leaves no gap after a restart when Redis still has the counter', async () => {
    const { allocator, redis } = build(100)
    redis.value = 100
    expect(await take(allocator, 1)).toEqual([101])
  })

  it('lifts the counter above the last seq when Redis forgets while running', async () => {
    const { allocator, lose, redis } = build()
    expect(await take(allocator, 5)).toEqual([1, 2, 3, 4, 5])
    lose(2)
    expect(await take(allocator, 2)).toEqual([6, 7])
    expect(redis.value).toBe(7)
  })

  it('never repeats a seq across any mix of Redis losses and restarts', async () => {
    const built = build()
    const seen: number[] = []
    let allocator = built.allocator
    for (let round = 0; round < 6; round++) {
      seen.push(...(await take(allocator, 37)))
      built.lose(round % 3)
      if (round % 2 === 0) allocator = built.restart()
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('brings the bound to the last seq at shutdown, so the next boot leaves no gap', async () => {
    const { allocator, db } = build()
    await take(allocator, 3)
    expect(db.reserved).toBe(SEQ_BLOCK_SIZE)
    await allocator.flushAll()
    expect(db.reserved).toBe(3)

    const { allocator: next } = build(db.reserved)
    expect(await take(next, 1)).toEqual([4])
  })

  it('writes nothing at shutdown when the bound is already the last seq', async () => {
    const { allocator, saves } = build(40)
    await allocator.open(ID)
    await allocator.flushAll()
    expect(saves).toEqual([])
  })

  it('keeps counting where it was when events come after the session stopped', async () => {
    const { allocator, saves } = build()
    await take(allocator, 3)
    // The status event of a stop is published after the pipeline closed: same count, same block
    expect(await take(allocator, 1)).toEqual([4])
    expect(saves).toEqual([SEQ_BLOCK_SIZE])
  })

  it('never lowers what it knows when a session is opened again', async () => {
    const { allocator, db } = build()
    await take(allocator, 5)
    db.reserved = 0
    await allocator.open(ID)
    expect(await take(allocator, 1)).toEqual([6])
  })

  it('starts from zero again for a session that was forgotten', async () => {
    const { allocator, db, redis } = build()
    await take(allocator, 5)
    allocator.forget(ID)
    db.reserved = 0
    redis.value = 0
    expect(await take(allocator, 1)).toEqual([1])
  })

  it('keeps the count of a next() that is waiting while the session is opened again', async () => {
    let release: () => void = () => undefined
    let calls = 0
    const allocator = new SeqAllocator({
      increment: () => Promise.resolve(++calls),
      set: () => Promise.resolve(),
      loadReserved: () => Promise.resolve(0),
      raiseReserved: () =>
        calls === 1
          ? new Promise<void>(resolve => {
              release = resolve
            })
          : Promise.resolve(),
      setReserved: () => Promise.resolve()
    })
    const first = allocator.next(ID)
    await Promise.resolve()
    await Promise.resolve()
    await allocator.open(ID)
    release()
    expect(await first).toBe(1)
    expect(await allocator.next(ID)).toBe(2)
  })

  it('opens the session by itself on the first seq', async () => {
    const { allocator } = build(10)
    expect(await take(allocator, 1)).toEqual([11])
  })

  describe('when the database does not take the bound', () => {
    afterEach(() => {
      jest.useRealTimers()
    })

    function failing(): { allocator: SeqAllocator; db: { reserved: number }; save: jest.Mock } {
      jest.useFakeTimers({ now: new Date('2026-10-28T12:00:00.000Z') })
      let counter = 0
      const db = { reserved: 0 }
      const save = jest
        .fn<Promise<void>, [string, number]>()
        .mockRejectedValueOnce(new Error('db'))
        .mockImplementation((_id, value) => {
          db.reserved = value
          return Promise.resolve()
        })
      const allocator = new SeqAllocator({
        increment: () => Promise.resolve(++counter),
        set: () => Promise.resolve(),
        loadReserved: () => Promise.resolve(0),
        raiseReserved: save,
        setReserved: save
      })
      return { allocator, db, save }
    }

    it('keeps the stream going and tries again after SEQ_RETRY_MS, covering what was handed out', async () => {
      const { allocator, db, save } = failing()
      expect(await take(allocator, 1)).toEqual([1])
      expect(await take(allocator, 3)).toEqual([2, 3, 4])
      expect(save).toHaveBeenCalledTimes(1)

      jest.setSystemTime(Date.now() + SEQ_RETRY_MS)
      expect(await take(allocator, 1)).toEqual([5])
      expect(save).toHaveBeenCalledTimes(2)
      expect(db.reserved).toBe(5 + SEQ_BLOCK_SIZE - 1)
    })

    it('puts the last seq in the database at shutdown even if no try succeeded', async () => {
      const { allocator, db } = failing()
      await take(allocator, 4)
      expect(db.reserved).toBe(0)
      await allocator.flushAll()
      expect(db.reserved).toBe(4)
    })

    it('does not fail the shutdown when the bound cannot be saved', async () => {
      const allocator = new SeqAllocator({
        increment: () => Promise.resolve(1),
        set: () => Promise.resolve(),
        loadReserved: () => Promise.resolve(0),
        raiseReserved: () => Promise.resolve(),
        setReserved: () => Promise.reject(new Error('db'))
      })
      await take(allocator, 1)
      await allocator.next(ID)
      await expect(allocator.flushAll()).resolves.toBeUndefined()
    })
  })

  it('refuses to start without the bound', async () => {
    const allocator = new SeqAllocator({
      increment: () => Promise.resolve(1),
      set: () => Promise.resolve(),
      loadReserved: () => Promise.reject(new Error('db down')),
      raiseReserved: () => Promise.resolve(),
      setReserved: () => Promise.resolve()
    })
    await expect(allocator.open(ID)).rejects.toThrow('db down')
    await expect(allocator.next(ID)).rejects.toThrow('db down')
  })
})
