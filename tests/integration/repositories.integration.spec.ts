import { randomUUID } from 'node:crypto'

import type { TestingModule } from '@nestjs/testing'

import { isUniqueViolation } from '../../src/database/db-errors.js'
import type { ApiKey, WebhookDelivery } from '../../src/database/models.js'
import { PrismaService } from '../../src/database/prisma.service.js'
import { ApiKeysRepository } from '../../src/database/repositories/api-keys.repository.js'
import { DeliveriesRepository } from '../../src/database/repositories/deliveries.repository.js'
import { IdempotencyRepository } from '../../src/database/repositories/idempotency.repository.js'
import { InboundHooksRepository } from '../../src/database/repositories/inbound-hooks.repository.js'
import {
  MessagesRepository,
  type NewStoredMessage
} from '../../src/database/repositories/messages.repository.js'
import { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import { SuppressionsRepository } from '../../src/database/repositories/suppressions.repository.js'
import { WebhooksRepository } from '../../src/database/repositories/webhooks.repository.js'
import { buildDatabaseModule } from '../helpers/database.js'

// Rows older than this belong to no real run, so a purge test can target only its own rows
const LONG_AGO = new Date('2000-01-01T00:00:00Z')
const CUTOFF = new Date('2001-01-01T00:00:00Z')
// The error a promise rejects with, so a test can look at its code and not only that it failed
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000000'

describe('repositories (integration)', () => {
  let module: TestingModule
  let prisma: PrismaService
  let sessions: SessionsRepository
  let apiKeys: ApiKeysRepository
  let webhooks: WebhooksRepository
  let deliveries: DeliveriesRepository
  let inboundHooks: InboundHooksRepository
  let messages: MessagesRepository
  let idempotency: IdempotencyRepository
  let suppressions: SuppressionsRepository

  // Each run owns the sessions it creates; deleting them cascades to nearly everything else
  const runId = randomUUID().slice(0, 8)
  const sessionIds: string[] = []
  const webhookIds: string[] = []
  const apiKeyIds: string[] = []

  const newSession = async (suffix: string): Promise<string> => {
    const id = `it-${runId}-${suffix}`
    sessionIds.push(id)
    await sessions.create({ id })
    return id
  }

  // Keys without a session are not removed by the cascade, so each one is tracked for the cleanup
  const newApiKey = async (
    suffix: string,
    over: Partial<Parameters<ApiKeysRepository['create']>[0]> = {}
  ): Promise<ApiKey> => {
    const key = await apiKeys.create({
      name: 'k',
      keyHash: `h-${runId}-${suffix}`,
      keyPrefix: 'wgk_',
      scopes: [],
      ...over
    })
    if (key === null) throw new Error('the key could not be created')
    apiKeyIds.push(key.id)
    return key
  }

  const newWebhook = async (sessionId: string | null): Promise<string> => {
    const webhook = await webhooks.create({
      sessionId,
      url: 'https://example.test/hook',
      secret: 's'
    })
    webhookIds.push(webhook.id)
    return webhook.id
  }

  beforeAll(async () => {
    module = await buildDatabaseModule()
    await module.init()
    prisma = module.get(PrismaService)
    sessions = module.get(SessionsRepository)
    apiKeys = module.get(ApiKeysRepository)
    webhooks = module.get(WebhooksRepository)
    deliveries = module.get(DeliveriesRepository)
    inboundHooks = module.get(InboundHooksRepository)
    messages = module.get(MessagesRepository)
    idempotency = module.get(IdempotencyRepository)
    suppressions = module.get(SuppressionsRepository)
  })

  // Cleans up even when a delete fails, and does not hide the error of a failed beforeAll
  afterAll(async () => {
    try {
      await prisma?.apiKey.deleteMany({ where: { id: { in: apiKeyIds } } })
      await prisma?.webhook.deleteMany({ where: { id: { in: webhookIds } } })
      await prisma?.idempotencyKey.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma?.session.deleteMany({ where: { id: { in: sessionIds } } })
    } finally {
      await module?.close()
    }
  })

  describe('sessions', () => {
    it('creates with defaults, finds, lists and patches', async () => {
      const id = await newSession('crud')

      const found = await sessions.findById(id)
      expect(found).toMatchObject({ id, status: 'created', autoStart: true, settings: {} })

      const updated = await sessions.update(id, {
        status: 'ready',
        phoneNumber: '1',
        settings: { humanize: true },
        lastError: null
      })
      expect(updated).toMatchObject({
        status: 'ready',
        phoneNumber: '1',
        settings: { humanize: true }
      })
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(found?.updatedAt.getTime() ?? 0)

      expect((await sessions.list()).map(s => s.id)).toContain(id)
    })

    it('merges settings key by key, in one statement, and bumps updatedAt', async () => {
      const id = await newSession('merge')
      await sessions.update(id, { settings: { a: 1, nested: { x: 1 } } })
      const before = await sessions.findById(id)
      expect(before).not.toBeNull()
      // `updatedAt` has millisecond precision: wait so that the merge cannot land in the same one
      await new Promise(resolve => setTimeout(resolve, 5))

      expect(await sessions.mergeSettings(id, { b: 2, nested: { y: 2 } })).toBe(true)

      const after = await sessions.findById(id)
      // A key that is given replaces the old value as a whole, the others stay
      expect(after?.settings).toEqual({ a: 1, b: 2, nested: { y: 2 } })
      expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() as number) // reason: asserted not null above
    })

    it('replaces a stored value that is not an object, and answers false for a missing session', async () => {
      const id = await newSession('merge-bad')
      await sessions.update(id, { settings: ['not', 'an', 'object'] })

      await sessions.mergeSettings(id, { a: 1 })

      expect((await sessions.findById(id))?.settings).toEqual({ a: 1 })
      expect(await sessions.mergeSettings(`ghost-${id}`, { a: 1 })).toBe(false)
    })

    it('only raises the seq bound with raiseSeqHighWater', async () => {
      const id = await newSession('seq-bound')
      expect((await sessions.findById(id))?.seqHighWater).toBe(0n)

      await sessions.raiseSeqHighWater(id, 200n)
      await sessions.raiseSeqHighWater(id, 100n)
      expect((await sessions.findById(id))?.seqHighWater).toBe(200n)

      await sessions.raiseSeqHighWater(id, 300n)
      expect((await sessions.findById(id))?.seqHighWater).toBe(300n)

      // `update` is the way down, for the shutdown
      await sessions.update(id, { seqHighWater: 250n })
      expect((await sessions.findById(id))?.seqHighWater).toBe(250n)
    })

    it('lists the auto-start sessions only', async () => {
      const on = await newSession('auto-on')
      const off = await newSession('auto-off')
      await sessions.update(off, { autoStart: false })

      const ids = (await sessions.listAutoStart()).map(s => s.id)

      expect(ids).toContain(on)
      expect(ids).not.toContain(off)
    })

    it('rejects a duplicate id and answers null for a missing one', async () => {
      const id = await newSession('dup')

      expect(isUniqueViolation(await rejection(sessions.create({ id })))).toBe(true)
      expect(await sessions.update('it-missing', { name: 'x' })).toBeNull()
      expect(await sessions.findById('it-missing')).toBeNull()
    })

    it('deletes and cascades to its children', async () => {
      const id = await newSession('cascade')
      await suppressions.add({ sessionId: id, chatId: 'c@c.us', reason: 'manual' })
      await apiKeys.create({
        name: 'k',
        keyHash: `h-${runId}-cascade`,
        keyPrefix: 'wgk_',
        sessionId: id,
        scopes: []
      })

      expect(await sessions.delete(id)).toBe(true)
      expect(await sessions.delete(id)).toBe(false)
      expect(await suppressions.list(id)).toEqual([])
      expect(await apiKeys.findByHash(`h-${runId}-cascade`)).toBeNull()
    })
  })

  describe('api keys', () => {
    it('creates, finds by id and by hash and lists', async () => {
      const created = await newApiKey('find', { keyPrefix: 'wgk_abcd', scopes: ['read'] })

      expect(created).toMatchObject({ sessionId: null, allowedCidrs: [], revokedAt: null })
      expect((await apiKeys.findById(created.id))?.keyHash).toBe(created.keyHash)
      expect((await apiKeys.findByHash(created.keyHash))?.id).toBe(created.id)
      expect((await apiKeys.list()).map(k => k.id)).toContain(created.id)
      expect(await apiKeys.findByHash('nope')).toBeNull()
    })

    it('refuses a second key with the same hash', async () => {
      const first = await newApiKey('unique')

      const duplicate = apiKeys.create({
        name: 'b',
        keyHash: first.keyHash,
        keyPrefix: 'wgk_',
        scopes: []
      })

      expect(isUniqueViolation(await rejection(duplicate))).toBe(true)
    })

    it('stamps the last use and revokes once, keeping the first date', async () => {
      const key = await newApiKey('revoke')
      const usedAt = new Date('2026-01-01T00:00:00Z')
      const first = new Date('2026-02-01T00:00:00Z')

      await apiKeys.touchLastUsed(key.id, usedAt)
      const revoked = await apiKeys.revoke(key.id, first)
      const again = await apiKeys.revoke(key.id, new Date('2026-03-01T00:00:00Z'))

      expect((await apiKeys.findById(key.id))?.lastUsedAt).toEqual(usedAt)
      expect(revoked?.revokedAt).toEqual(first)
      expect(again?.revokedAt).toEqual(first)
      expect(await apiKeys.revoke(MISSING_UUID, first)).toBeNull()
    })

    it('keeps the first date when two revocations race', async () => {
      const key = await newApiKey('revoke-race')
      const dates = [1, 2, 3, 4, 5, 6].map(day => new Date(Date.UTC(2026, 0, day)))

      await Promise.all(dates.map(at => apiKeys.revoke(key.id, at)))

      const stored = (await apiKeys.findById(key.id))?.revokedAt
      expect(dates.map(d => d.getTime())).toContain(stored?.getTime())
      // Whoever won, a later call does not move it
      await apiKeys.revoke(key.id, new Date('2030-01-01T00:00:00Z'))
      expect((await apiKeys.findById(key.id))?.revokedAt).toEqual(stored)
    })

    it('answers null instead of failing when the session of the key does not exist', async () => {
      const hash = `h-${runId}-no-session`

      const created = await apiKeys.create({
        name: 'k',
        keyHash: hash,
        keyPrefix: 'wgk_',
        sessionId: `missing-${runId}`,
        scopes: []
      })

      expect(created).toBeNull()
      expect(await apiKeys.findByHash(hash)).toBeNull()
    })

    it('rotates: the new key points at the old one and the old one gets an end date', async () => {
      const old = await newApiKey('old', { scopes: ['send'] })
      const graceEnd = new Date('2030-01-01T00:00:00Z')

      const next = await apiKeys.rotate(
        old.id,
        () => ({ name: 'k', keyHash: `h-${runId}-new`, keyPrefix: 'wgk_', scopes: ['send'] }),
        graceEnd
      )
      if (next) apiKeyIds.push(next.id)

      expect(next).toMatchObject({ rotatedFromId: old.id, scopes: ['send'] })
      expect((await apiKeys.findById(old.id))?.expiresAt).toEqual(graceEnd)
    })

    it('hands the replacement builder the old row as the transaction read it', async () => {
      const old = await newApiKey('builder', { scopes: ['read'], allowedCidrs: ['10.0.0.0/8'] })
      const seen: ApiKey[] = []

      const next = await apiKeys.rotate(
        old.id,
        row => {
          seen.push(row)
          return {
            name: row.name,
            keyHash: `h-${runId}-builder-new`,
            keyPrefix: 'wgk_',
            scopes: row.scopes
          }
        },
        new Date('2030-01-01T00:00:00Z')
      )
      if (next) apiKeyIds.push(next.id)

      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ id: old.id, scopes: ['read'], allowedCidrs: ['10.0.0.0/8'] })
      expect(next).toMatchObject({ scopes: ['read'] })
    })

    it('does not extend a key that expires sooner than the grace period', async () => {
      const soon = new Date('2029-01-01T00:00:00Z')
      const old = await newApiKey('soon', { expiresAt: soon })

      const next = await apiKeys.rotate(
        old.id,
        () => ({ name: 'k', keyHash: `h-${runId}-soon-new`, keyPrefix: 'wgk_', scopes: [] }),
        new Date('2030-01-01T00:00:00Z')
      )
      if (next) apiKeyIds.push(next.id)

      expect((await apiKeys.findById(old.id))?.expiresAt).toEqual(soon)
    })

    it('rolls back the end date of the old key when the new key cannot be written', async () => {
      const old = await newApiKey('atomic')
      const taken = await newApiKey('atomic-taken')

      const rotation = apiKeys.rotate(
        old.id,
        () => ({ name: 'k', keyHash: taken.keyHash, keyPrefix: 'wgk_', scopes: [] }),
        new Date('2030-01-01T00:00:00Z')
      )

      expect(isUniqueViolation(await rejection(rotation))).toBe(true)
      expect((await apiKeys.findById(old.id))?.expiresAt).toBeNull()
    })

    it('settles two rotations at once instead of failing one of them', async () => {
      const old = await newApiKey('race')
      const rotate = (n: number): Promise<ApiKey | null> =>
        apiKeys.rotate(
          old.id,
          () => ({ name: 'k', keyHash: `h-${runId}-race-${n}`, keyPrefix: 'wgk_', scopes: [] }),
          new Date('2030-01-01T00:00:00Z')
        )

      const results = await Promise.all([rotate(1), rotate(2)])

      for (const key of results) if (key) apiKeyIds.push(key.id)
      expect(results.every(key => key?.rotatedFromId === old.id)).toBe(true)
    })

    it('does not rotate a revoked key', async () => {
      const old = await newApiKey('rotate-revoked')
      await apiKeys.revoke(old.id, new Date())
      const hash = `h-${runId}-rotate-revoked-new`

      const next = await apiKeys.rotate(
        old.id,
        () => ({ name: 'k', keyHash: hash, keyPrefix: 'wgk_', scopes: [] }),
        new Date('2030-01-01T00:00:00Z')
      )

      expect(next).toBeNull()
      expect(await apiKeys.findByHash(hash)).toBeNull()
    })

    it('writes nothing when the key to rotate does not exist', async () => {
      const hash = `h-${runId}-orphan`

      const result = await apiKeys.rotate(
        MISSING_UUID,
        () => ({ name: 'k', keyHash: hash, keyPrefix: 'wgk_', scopes: [] }),
        new Date()
      )

      expect(result).toBeNull()
      expect(await apiKeys.findByHash(hash)).toBeNull()
    })
  })

  describe('webhooks', () => {
    it('creates with defaults, patches and deletes', async () => {
      const id = await newWebhook(null)

      expect(await webhooks.findById(id)).toMatchObject({
        sessionId: null,
        events: ['*'],
        enabled: true,
        mediaMode: 'reference'
      })
      const updated = await webhooks.update(id, {
        enabled: false,
        events: ['message'],
        mediaMode: 'inline'
      })
      expect(updated).toMatchObject({ enabled: false, events: ['message'], mediaMode: 'inline' })
      expect(await webhooks.update(MISSING_UUID, { enabled: false })).toBeNull()
      expect(await webhooks.delete(id)).toBe(true)
      expect(await webhooks.delete(id)).toBe(false)
    })

    it('lists by session and picks the enabled ones for an event source', async () => {
      const a = await newSession('wh-a')
      const b = await newSession('wh-b')
      const own = await newWebhook(a)
      const global = await newWebhook(null)
      const other = await newWebhook(b)
      const disabled = await newWebhook(a)
      await webhooks.update(disabled, { enabled: false })

      const forA = (await webhooks.listEnabledFor(a)).map(w => w.id)

      expect(forA).toEqual(expect.arrayContaining([own, global]))
      expect(forA).not.toContain(other)
      expect(forA).not.toContain(disabled)
      expect((await webhooks.list(a)).map(w => w.id).sort()).toEqual([own, disabled].sort())
      expect((await webhooks.list()).map(w => w.id)).toEqual(
        expect.arrayContaining([own, other, global])
      )
    })
  })

  describe('deliveries', () => {
    const payload = { hello: 'world' }
    const at = (second: number): Date => new Date(Date.UTC(2026, 4, 1, 0, 0, second))

    // The clock is never relied on: the test sets the creation dates itself
    const make = async (
      webhookId: string,
      seq: bigint,
      createdAt: Date
    ): Promise<WebhookDelivery> => {
      const created = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq,
        payload
      })
      return prisma.webhookDelivery.update({ where: { id: created.id }, data: { createdAt } })
    }

    it('creates pending, records attempts and stamps the delivery date', async () => {
      const webhookId = await newWebhook(null)
      const created = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 9007199254740993n,
        payload
      })

      expect(created).toMatchObject({ status: 'pending', attempts: 0, seq: 9007199254740993n })

      const retry = await deliveries.recordAttempt(
        created.id,
        { status: 'pending', statusCode: 503, error: 'down' },
        new Date()
      )
      expect(retry).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastStatusCode: 503,
        lastError: 'down',
        deliveredAt: null
      })

      const done = await deliveries.recordAttempt(
        created.id,
        { status: 'success', statusCode: 200 },
        at(5)
      )
      expect(done).toMatchObject({
        status: 'success',
        attempts: 2,
        lastStatusCode: 200,
        lastError: null,
        deliveredAt: at(5)
      })
      expect(await deliveries.recordAttempt(MISSING_UUID, { status: 'failed' }, at(5))).toBeNull()
    })

    it('counts attempts that are recorded at the same time', async () => {
      const webhookId = await newWebhook(null)
      const created = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 1n,
        payload
      })

      await Promise.all([
        deliveries.recordAttempt(created.id, { status: 'pending' }, at(1)),
        deliveries.recordAttempt(created.id, { status: 'pending' }, at(1))
      ])

      expect((await deliveries.findById(created.id))?.attempts).toBe(2)
    })

    it('does not let a late result undo a delivery', async () => {
      const webhookId = await newWebhook(null)
      const created = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 1n,
        payload
      })
      await deliveries.recordAttempt(created.id, { status: 'success', statusCode: 200 }, at(1))

      const late = await deliveries.recordAttempt(
        created.id,
        { status: 'failed', error: 'timeout' },
        at(2)
      )

      expect(late).toBeNull()
      expect(await deliveries.findById(created.id)).toMatchObject({
        status: 'success',
        attempts: 1,
        lastError: null,
        deliveredAt: at(1)
      })
    })

    it('lists newest first, filters by status and pages with a cursor', async () => {
      const webhookId = await newWebhook(null)
      const one = await make(webhookId, 1n, at(1))
      const two = await make(webhookId, 2n, at(2))
      const three = await make(webhookId, 3n, at(3))
      await deliveries.recordAttempt(two.id, { status: 'failed', error: 'x' }, new Date())

      const all = await deliveries.listForWebhook(webhookId, { limit: 10 })
      const failed = await deliveries.listForWebhook(webhookId, { limit: 10, status: 'failed' })
      const older = await deliveries.listForWebhook(webhookId, { limit: 10, before: three })

      expect(all.map(d => d.id)).toEqual([three.id, two.id, one.id])
      expect(failed.map(d => d.id)).toEqual([two.id])
      expect(older.map(d => d.id)).toEqual([two.id, one.id])
      expect(await deliveries.listForWebhook(webhookId, { limit: 1 })).toHaveLength(1)
    })

    it('skips none and repeats none when several deliveries share a creation date', async () => {
      const webhookId = await newWebhook(null)
      const same = await Promise.all([1n, 2n, 3n, 4n, 5n].map(seq => make(webhookId, seq, at(1))))

      const seen: string[] = []
      let before: { createdAt: Date; id: string } | undefined
      for (let page = 0; page < 5; page += 1) {
        const rows = await deliveries.listForWebhook(webhookId, { limit: 2, before })
        seen.push(...rows.map(d => d.id))
        const last = rows.at(-1)
        if (!last) break
        before = last
      }

      expect([...seen].sort()).toEqual(same.map(d => d.id).sort())
    })

    it('puts a dead letter back to pending, keeping the attempts', async () => {
      const webhookId = await newWebhook(null)
      const created = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 1n,
        payload
      })
      await deliveries.recordAttempt(created.id, { status: 'failed', error: 'x' }, new Date())

      const reset = await deliveries.resetForRetry(created.id)

      expect(reset).toMatchObject({ status: 'pending', attempts: 1 })
      expect(await deliveries.resetForRetry(MISSING_UUID)).toBeNull()
    })

    it('does not reset a delivery that is not a dead letter', async () => {
      const webhookId = await newWebhook(null)
      const pending = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 1n,
        payload
      })
      const delivered = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 2n,
        payload
      })
      await deliveries.recordAttempt(delivered.id, { status: 'success', statusCode: 200 }, at(1))

      expect(await deliveries.resetForRetry(pending.id)).toBeNull()
      expect(await deliveries.resetForRetry(delivered.id)).toBeNull()
      expect((await deliveries.findById(delivered.id))?.status).toBe('success')
    })

    it('goes away with its webhook', async () => {
      const webhookId = await newWebhook(null)
      const created = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 1n,
        payload
      })

      await webhooks.delete(webhookId)

      expect(await deliveries.findById(created.id)).toBeNull()
    })

    it('purges only what is older than the cutoff', async () => {
      const webhookId = await newWebhook(null)
      const old = await make(webhookId, 1n, LONG_AGO)
      const fresh = await deliveries.create({
        webhookId,
        sessionId: 's',
        event: 'message',
        seq: 2n,
        payload
      })

      expect(await deliveries.deleteOlderThan(CUTOFF)).toBeGreaterThanOrEqual(1)

      expect(await deliveries.findById(old.id)).toBeNull()
      expect(await deliveries.findById(fresh.id)).not.toBeNull()
    })
  })

  describe('inbound hooks', () => {
    it('creates, finds by hash, lists by session and revokes once', async () => {
      const sessionId = await newSession('hook')
      const hook = await inboundHooks.create({ sessionId, name: 'crisp', tokenHash: `t-${runId}` })

      expect((await inboundHooks.findByTokenHash(`t-${runId}`))?.id).toBe(hook.id)
      expect((await inboundHooks.listForSession(sessionId)).map(h => h.id)).toEqual([hook.id])

      const first = new Date('2026-02-01T00:00:00Z')
      expect((await inboundHooks.revoke(hook.id, first))?.revokedAt).toEqual(first)
      expect((await inboundHooks.revoke(hook.id, new Date()))?.revokedAt).toEqual(first)
      // A revoked hook is still found, so the caller can tell it from an unknown one
      expect((await inboundHooks.findByTokenHash(`t-${runId}`))?.revokedAt).toEqual(first)
      expect(await inboundHooks.revoke(MISSING_UUID, first)).toBeNull()
      expect(await inboundHooks.findByTokenHash('unknown')).toBeNull()
    })
  })

  describe('messages', () => {
    const message = (
      sessionId: string,
      id: string,
      over: Partial<NewStoredMessage> = {}
    ): NewStoredMessage => ({
      id,
      sessionId,
      chatId: 'chat@c.us',
      direction: 'in',
      fromMe: false,
      type: 'chat',
      body: 'hi',
      hasMedia: false,
      ack: 0,
      sentAt: new Date('2026-06-01T10:00:00Z'),
      receivedAt: new Date('2026-06-01T10:00:01Z'),
      dto: { id },
      ...over
    })

    it('stores a message without a date of publication', async () => {
      const sessionId = await newSession('msg-store')

      const stored = await messages.upsert(message(sessionId, 'm1', { origin: { sourceId: 'ad' } }))

      expect(stored).toMatchObject({ emittedAt: null, origin: { sourceId: 'ad' }, body: 'hi' })
      expect(await messages.findById(sessionId, 'm1')).not.toBeNull()
      expect(await messages.findById(sessionId, 'nope')).toBeNull()
    })

    it('refreshes a repeated message but keeps its arrival data and its publication date', async () => {
      const sessionId = await newSession('msg-upsert')
      await messages.upsert(message(sessionId, 'm1'))
      const emittedAt = new Date('2026-06-01T10:00:05Z')
      await messages.markEmitted(sessionId, ['m1'], emittedAt)

      const again = await messages.upsert(
        message(sessionId, 'm1', {
          ack: 2,
          body: 'edited',
          receivedAt: new Date('2026-06-02T00:00:00Z')
        })
      )

      expect(again).toMatchObject({ ack: 2, body: 'edited', emittedAt })
      expect(again.receivedAt).toEqual(new Date('2026-06-01T10:00:01Z'))
    })

    it('tells which ids are already stored', async () => {
      const sessionId = await newSession('msg-exist')
      await messages.upsert(message(sessionId, 'm1'))

      expect(await messages.findExistingIds(sessionId, ['m1', 'm2'])).toEqual(new Set(['m1']))
      expect(await messages.findExistingIds(sessionId, [])).toEqual(new Set())
    })

    it('moves the ack forward only, and reports a missing message', async () => {
      const sessionId = await newSession('msg-ack')
      await messages.upsert(message(sessionId, 'm1'))

      expect(await messages.updateAck(sessionId, 'm1', 3)).toBe(true)
      expect(await messages.updateAck(sessionId, 'nope', 3)).toBe(false)
      expect(await messages.updateAck(sessionId, 'm1', 2)).toBe(false)
      expect(await messages.updateAck(sessionId, 'm1', 3)).toBe(false)
      expect((await messages.findById(sessionId, 'm1'))?.ack).toBe(3)
    })

    it('stores a message without an ack, and the first ack that follows applies', async () => {
      const sessionId = await newSession('msg-ack-null')
      await messages.upsert(message(sessionId, 'm1', { ack: null }))
      await messages.upsert(message(sessionId, 'm2', { ack: null }))

      expect((await messages.findById(sessionId, 'm1'))?.ack).toBeNull()
      expect(await messages.updateAck(sessionId, 'm1', 1)).toBe(true)
      expect((await messages.findById(sessionId, 'm1'))?.ack).toBe(1)
      // An error ack applies to an unknown one as well
      expect(await messages.updateAck(sessionId, 'm2', -1)).toBe(true)
      expect((await messages.findById(sessionId, 'm2'))?.ack).toBe(-1)
    })

    it('applies an ack of -1 (error) whatever the stored one', async () => {
      const sessionId = await newSession('msg-ack-error')
      await messages.upsert(message(sessionId, 'm1', { ack: 2 }))

      expect(await messages.updateAck(sessionId, 'm1', -1)).toBe(true)
      expect(await messages.updateAck(sessionId, 'm1', -1)).toBe(false)
      expect((await messages.findById(sessionId, 'm1'))?.ack).toBe(-1)
      // An ack after the error replaces it (the message was sent again), then only moves forward
      expect(await messages.updateAck(sessionId, 'm1', 0)).toBe(true)
      expect(await messages.updateAck(sessionId, 'm1', 1)).toBe(true)
      expect(await messages.updateAck(sessionId, 'm1', 0)).toBe(false)
    })

    it('marks as published once and lists the unpublished incoming ones in sent order', async () => {
      const sessionId = await newSession('msg-unemitted')
      await messages.upsert(
        message(sessionId, 'late', { sentAt: new Date('2026-06-01T10:00:09Z') })
      )
      await messages.upsert(
        message(sessionId, 'early', { sentAt: new Date('2026-06-01T10:00:02Z') })
      )
      await messages.upsert(message(sessionId, 'mine', { direction: 'out', fromMe: true }))
      await messages.upsert(message(sessionId, 'done'))
      const at = new Date('2026-06-01T10:01:00Z')
      expect(await messages.markEmitted(sessionId, ['done'], at)).toBe(1)
      expect(await messages.markEmitted(sessionId, ['done'], new Date())).toBe(0)

      const held = await messages.listUnemitted(sessionId)

      expect(held.map(m => m.id)).toEqual(['early', 'late'])
      expect((await messages.findById(sessionId, 'done'))?.emittedAt).toEqual(at)
    })

    it('lists the unpublished incoming messages of one chat', async () => {
      const sessionId = await newSession('msg-unemitted-chat')
      await messages.upsert(message(sessionId, 'a'))
      await messages.upsert(message(sessionId, 'b', { chatId: 'other@c.us' }))

      const held = await messages.listUnemitted(sessionId, 'other@c.us')

      expect(held.map(m => m.id)).toEqual(['b'])
    })

    it('lists a chat newest first, with a cursor and a limit', async () => {
      const sessionId = await newSession('msg-list')
      const at = (second: number): Date => new Date(Date.UTC(2026, 5, 1, 10, 0, second))
      await messages.upsert(message(sessionId, 'a', { sentAt: at(1) }))
      await messages.upsert(message(sessionId, 'b', { sentAt: at(2) }))
      await messages.upsert(message(sessionId, 'c', { sentAt: at(3) }))
      await messages.upsert(message(sessionId, 'x', { chatId: 'other@c.us', sentAt: at(4) }))

      const chat = await messages.listStored({ sessionId, chatId: 'chat@c.us', limit: 10 })
      const page = await messages.listStored({
        sessionId,
        chatId: 'chat@c.us',
        before: { sentAt: at(3), id: 'c' },
        limit: 1
      })
      const everyChat = await messages.listStored({ sessionId, limit: 10 })

      expect(chat.map(m => m.id)).toEqual(['c', 'b', 'a'])
      expect(page.map(m => m.id)).toEqual(['b'])
      expect(everyChat.map(m => m.id)).toEqual(['x', 'c', 'b', 'a'])
    })

    it('skips none and repeats none when several messages were sent in the same second', async () => {
      const sessionId = await newSession('msg-ties')
      const sentAt = new Date('2026-06-01T10:00:00Z')
      const ids = ['a', 'b', 'c', 'd', 'e']
      for (const id of ids) await messages.upsert(message(sessionId, id, { sentAt }))

      const seen: string[] = []
      let before: { sentAt: Date; id: string } | undefined
      for (let page = 0; page < 5; page += 1) {
        const rows = await messages.listStored({ sessionId, limit: 2, before })
        seen.push(...rows.map(m => m.id))
        const last = rows.at(-1)
        if (!last) break
        before = last
      }

      expect(seen).toEqual(['e', 'd', 'c', 'b', 'a'])
    })

    it('keeps the fields that identify the message when it is stored again', async () => {
      const sessionId = await newSession('msg-keep')
      const first = message(sessionId, 'm1', { origin: { sourceId: 'ad' }, hasMedia: true })
      await messages.upsert(first)

      const again = await messages.upsert(
        message(sessionId, 'm1', {
          chatId: 'other@c.us',
          direction: 'out',
          fromMe: true,
          type: 'image',
          sentAt: new Date('2027-01-01T00:00:00Z'),
          origin: { sourceId: 'changed' },
          body: null,
          hasMedia: false,
          dto: { id: 'm1', changed: true }
        })
      )

      expect(again).toMatchObject({
        chatId: 'chat@c.us',
        direction: 'in',
        fromMe: false,
        type: 'chat',
        sentAt: first.sentAt,
        origin: { sourceId: 'ad' },
        body: null,
        hasMedia: false,
        dto: { id: 'm1', changed: true }
      })
    })

    it('keeps messages of different sessions apart', async () => {
      const a = await newSession('msg-iso-a')
      const b = await newSession('msg-iso-b')
      await messages.upsert(message(a, 'same'))

      expect(await messages.findById(b, 'same')).toBeNull()
      expect(await messages.findExistingIds(b, ['same'])).toEqual(new Set())
      expect(await messages.updateAck(b, 'same', 3)).toBe(false)
      expect(await messages.markEmitted(b, ['same'], new Date())).toBe(0)
      expect(await messages.markEmitted(a, [], new Date())).toBe(0)
      expect((await messages.findById(a, 'same'))?.ack).toBe(0)
    })

    it('goes away with its session', async () => {
      const id = await newSession('msg-cascade')
      await messages.upsert(message(id, 'm1'))

      await sessions.delete(id)

      expect(await messages.findById(id, 'm1')).toBeNull()
    })

    it('tells when the contact last wrote in a chat by arrival, ignoring our own messages and other chats', async () => {
      const sessionId = await newSession('msg-last-in')
      const at = (second: number): Date => new Date(Date.UTC(2026, 5, 1, 10, 0, second))
      // The sender's clock is wrong on the first message: it claims a time far in the future
      await messages.upsert(message(sessionId, 'a', { sentAt: at(9000), receivedAt: at(1) }))
      await messages.upsert(message(sessionId, 'b', { sentAt: at(2), receivedAt: at(5) }))
      await messages.upsert(
        message(sessionId, 'mine', { direction: 'out', fromMe: true, receivedAt: at(9) })
      )
      await messages.upsert(message(sessionId, 'x', { chatId: 'other@c.us', receivedAt: at(12) }))

      expect(await messages.lastIncomingAt(sessionId, 'chat@c.us')).toEqual(at(5))
      expect(await messages.lastIncomingAt(sessionId, 'nobody@c.us')).toBeNull()
    })

    it('lists the last messages we sent to a chat, newest first, with their ack', async () => {
      const sessionId = await newSession('msg-recent-out')
      const at = (second: number): Date => new Date(Date.UTC(2026, 5, 1, 10, 0, second))
      const out = { direction: 'out', fromMe: true } as const
      await messages.upsert(message(sessionId, 'o1', { ...out, ack: 3, sentAt: at(1) }))
      await messages.upsert(message(sessionId, 'o2', { ...out, ack: 1, sentAt: at(2) }))
      await messages.upsert(message(sessionId, 'o3', { ...out, ack: 1, sentAt: at(3) }))
      await messages.upsert(message(sessionId, 'in', { sentAt: at(4) }))

      expect(await messages.listRecentOutgoing(sessionId, 'chat@c.us', 2)).toEqual([
        { ack: 1, sentAt: at(3) },
        { ack: 1, sentAt: at(2) }
      ])
    })

    it('purges what arrived before the cutoff, but keeps a message that was never published', async () => {
      const sessionId = await newSession('msg-purge')
      const old = { receivedAt: LONG_AGO }
      await messages.upsert(message(sessionId, 'published', old))
      await messages.markEmitted(sessionId, ['published'], LONG_AGO)
      await messages.upsert(message(sessionId, 'sent', { ...old, direction: 'out', fromMe: true }))
      await messages.upsert(message(sessionId, 'held', old))
      await messages.upsert(message(sessionId, 'fresh'))
      await messages.markEmitted(sessionId, ['fresh'], new Date())

      expect(await messages.deleteOlderThan(CUTOFF)).toBeGreaterThanOrEqual(2)

      expect(await messages.findById(sessionId, 'published')).toBeNull()
      expect(await messages.findById(sessionId, 'sent')).toBeNull()
      expect(await messages.findById(sessionId, 'held')).not.toBeNull()
      expect(await messages.findById(sessionId, 'fresh')).not.toBeNull()
    })
  })

  describe('idempotency', () => {
    it('lets exactly one of several concurrent claims win', async () => {
      const sessionId = await newSession('idem-race')

      const results = await Promise.all(
        Array.from({ length: 8 }, () => idempotency.claim(sessionId, 'k1', 'hash-a'))
      )

      expect(results.filter(r => r.claimed)).toHaveLength(1)
      for (const result of results) {
        if (!result.claimed)
          expect(result.existing).toMatchObject({ requestHash: 'hash-a', status: 'pending' })
      }
    })

    it('shows what the first claim became once it is completed', async () => {
      const sessionId = await newSession('idem-done')
      await idempotency.claim(sessionId, 'k1', 'hash-a')

      const finished = await idempotency.complete(sessionId, 'k1', {
        messageId: 'm1',
        response: { ok: true }
      })
      const second = await idempotency.claim(sessionId, 'k1', 'hash-b')

      expect(finished).toBe(true)
      expect(second).toMatchObject({
        claimed: false,
        existing: { requestHash: 'hash-a', status: 'done' }
      })
    })

    it('records a failure with its message id and keeps keys of different sessions apart', async () => {
      const a = await newSession('idem-a')
      const b = await newSession('idem-b')
      await idempotency.claim(a, 'k1', 'h')

      const failed = await idempotency.fail(a, 'k1', {
        messageId: 'm9',
        response: { code: 'UNKNOWN_OUTCOME' }
      })

      expect(failed).toBe(true)
      expect(await idempotency.find(a, 'k1')).toMatchObject({
        status: 'failed',
        messageId: 'm9',
        response: { code: 'UNKNOWN_OUTCOME' }
      })
      expect(await idempotency.claim(b, 'k1', 'h')).toEqual({ claimed: true })
      expect(await idempotency.find(b, 'k1')).toMatchObject({ status: 'pending' })
      expect(await idempotency.complete(a, 'nope', {})).toBe(false)
      expect(await idempotency.find(a, 'nope')).toBeNull()
    })

    it('ends a key once: a send that is done never turns into a failure, nor the reverse', async () => {
      const sessionId = await newSession('idem-final')
      await idempotency.claim(sessionId, 'sent', 'h')
      await idempotency.claim(sessionId, 'failed', 'h')
      await idempotency.complete(sessionId, 'sent', { messageId: 'm1', response: { ok: true } })
      await idempotency.fail(sessionId, 'failed', { response: { code: 'X' } })

      expect(await idempotency.fail(sessionId, 'sent', { response: { code: 'LATE' } })).toBe(false)
      expect(await idempotency.complete(sessionId, 'failed', { messageId: 'm2' })).toBe(false)

      expect(await idempotency.find(sessionId, 'sent')).toMatchObject({
        status: 'done',
        messageId: 'm1',
        response: { ok: true }
      })
      expect(await idempotency.find(sessionId, 'failed')).toMatchObject({
        status: 'failed',
        messageId: null,
        response: { code: 'X' }
      })
    })

    it('releases a pending key and leaves a finished one alone', async () => {
      const sessionId = await newSession('idem-release')
      await idempotency.claim(sessionId, 'pending', 'h')
      await idempotency.claim(sessionId, 'done', 'h')
      await idempotency.complete(sessionId, 'done', { messageId: 'm1', response: { ok: true } })
      await idempotency.claim(sessionId, 'failed', 'h')
      await idempotency.fail(sessionId, 'failed', { response: { ok: false } })

      expect(await idempotency.release(sessionId, 'pending')).toBe(true)
      expect(await idempotency.release(sessionId, 'done')).toBe(false)
      expect(await idempotency.release(sessionId, 'failed')).toBe(false)
      expect(await idempotency.release(sessionId, 'unknown')).toBe(false)

      expect(await idempotency.find(sessionId, 'pending')).toBeNull()
      expect(await idempotency.find(sessionId, 'done')).toMatchObject({ status: 'done' })
      expect(await idempotency.find(sessionId, 'failed')).toMatchObject({ status: 'failed' })
      expect(await idempotency.claim(sessionId, 'pending', 'h2')).toEqual({ claimed: true })
    })

    it('purges only what is older than the cutoff', async () => {
      const sessionId = await newSession('idem-purge')
      await idempotency.claim(sessionId, 'old', 'h')
      await idempotency.claim(sessionId, 'fresh', 'h')
      await prisma.idempotencyKey.update({
        where: { sessionId_key: { sessionId, key: 'old' } },
        data: { createdAt: LONG_AGO }
      })

      expect(await idempotency.deleteOlderThan(CUTOFF)).toBeGreaterThanOrEqual(1)

      expect(await idempotency.find(sessionId, 'old')).toBeNull()
      expect(await idempotency.find(sessionId, 'fresh')).not.toBeNull()
    })
  })

  describe('suppressions', () => {
    it('adds once, keeps the first reason and answers whether a chat is suppressed', async () => {
      const sessionId = await newSession('sup')

      const first = await suppressions.add({
        sessionId,
        chatId: 'c@c.us',
        reason: 'opt_out',
        note: 'stop'
      })
      const second = await suppressions.add({ sessionId, chatId: 'c@c.us', reason: 'manual' })

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.suppression).toMatchObject({ reason: 'opt_out', note: 'stop' })
      expect(await suppressions.isSuppressed(sessionId, 'c@c.us')).toBe(true)
      expect(await suppressions.isSuppressed(sessionId, 'other@c.us')).toBe(false)
      expect((await suppressions.list(sessionId)).map(s => s.chatId)).toEqual(['c@c.us'])
    })

    it('removes an entry and reports a chat that was not there', async () => {
      const sessionId = await newSession('sup-rm')
      await suppressions.add({ sessionId, chatId: 'c@c.us', reason: 'manual' })

      expect(await suppressions.remove(sessionId, 'c@c.us')).toBe(true)
      expect(await suppressions.remove(sessionId, 'c@c.us')).toBe(false)
      expect(await suppressions.isSuppressed(sessionId, 'c@c.us')).toBe(false)
    })
  })
})
