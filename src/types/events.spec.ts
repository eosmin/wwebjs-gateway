import { z } from 'zod'

import { exampleOf } from '../../scripts/lib/json-schema-example.js'
import { ErrorCode } from '../common/errors.js'

import { WA_EVENT_NAMES, WA_EVENTS, eventEnvelope, type WaEventName } from './events.js'

// A snapshot of Constants.js of whatsapp-web.js 1.34.7 and TDD §2.5. whatsapp-web.js is not a
// dependency yet; the parity test of the adapter phase compares this list with the installed library.
const WWEBJS_EVENTS = [
  'authenticated',
  'auth_failure',
  'ready',
  'chat_removed',
  'chat_archived',
  'message',
  'message_ciphertext',
  'message_ciphertext_failed',
  'message_create',
  'message_revoke_everyone',
  'message_revoke_me',
  'message_ack',
  'message_edit',
  'unread_count',
  'message_reaction',
  'media_uploaded',
  'contact_changed',
  'group_join',
  'group_leave',
  'group_admin_changed',
  'group_membership_request',
  'group_update',
  'qr',
  'code',
  'loading_screen',
  'disconnected',
  'change_state',
  'change_battery',
  'call',
  'remote_session_saved',
  'vote_update'
]

// TDD §5.4
const SYNTHESIZED_EVENTS = [
  'session_status',
  'message_batch',
  'message_sent',
  'message_failed',
  'session_error',
  'chat_suppressed',
  'chat_unreachable',
  'ping'
]

function exampleOfPayload(name: WaEventName): unknown {
  const { $defs, ...top } = z.toJSONSchema(WA_EVENTS[name].payload) as z.core.JSONSchema.JSONSchema
  return exampleOf(top, $defs ?? {})
}

describe('WA_EVENT_NAMES', () => {
  it('lists the 31 events of wwebjs and then the 8 of the gateway, each once', () => {
    expect(WWEBJS_EVENTS).toHaveLength(31)
    expect(WA_EVENT_NAMES.slice(0, 31).sort()).toEqual([...WWEBJS_EVENTS].sort())
    expect(WA_EVENT_NAMES.slice(31)).toEqual(SYNTHESIZED_EVENTS)
    expect(new Set(WA_EVENT_NAMES).size).toBe(WA_EVENT_NAMES.length)
  })

  it('has a catalog entry for every name and none more', () => {
    expect(Object.keys(WA_EVENTS).sort()).toEqual([...WA_EVENT_NAMES].sort())
  })

  it.each(WA_EVENT_NAMES)('%s says when it fires', name => {
    expect(WA_EVENTS[name].fires).toMatch(/\.$/)
  })
})

describe('the payload schemas', () => {
  // The example of docs/events.md is built from the schema: it has to be a valid payload. The contract
  // itself is held by the rejections below.
  it.each(WA_EVENT_NAMES)('%s has an example that its own schema accepts', name => {
    const { $defs, ...top } = z.toJSONSchema(
      WA_EVENTS[name].payload
    ) as z.core.JSONSchema.JSONSchema

    const result = WA_EVENTS[name].payload.safeParse(exampleOf(top, $defs ?? {}))

    expect(result.error?.issues).toBeUndefined()
  })

  it.each([
    ['qr', { qr: 42 }],
    ['loading_screen', { percent: 50, message: 'Loading' }],
    ['message_ack', { message: exampleOfPayload('message'), ack: 1.5 }],
    ['message_ack', { ack: 1 }],
    ['chat_archived', { chat: exampleOfPayload('chat_removed'), currState: true }],
    ['chat_suppressed', { chatId: '1@c.us', reason: 'spam' }],
    ['chat_unreachable', { chatId: '1@c.us', unreachable: 'yes' }],
    ['session_error', { code: 'X' }],
    ['group_join', { id: 'x' }],
    ['message', { id: 'x' }]
  ] as const)('%s rejects a bad payload (%#)', (name, data) => {
    expect(WA_EVENTS[name].payload.safeParse(data).success).toBe(false)
  })

  it('message_failed carries an error code the API knows', () => {
    const payload = WA_EVENTS.message_failed.payload
    const error = { code: 'UNKNOWN_OUTCOME', message: 'timed out' }

    expect(payload.safeParse({ jobId: 'j1', error }).success).toBe(true)
    expect(payload.safeParse({ jobId: 'j1', error: { ...error, code: 'NOPE' } }).success).toBe(
      false
    )
    expect(Object.values(ErrorCode)).toContain(error.code)
  })

  it('session_status only takes statuses of the session machine', () => {
    const payload = WA_EVENTS.session_status.payload

    expect(payload.safeParse({ status: 'ready', previous: 'authenticating' }).success).toBe(true)
    expect(payload.safeParse({ status: 'ready', previous: 'booting' }).success).toBe(false)
  })

  it('message_batch takes the reasons of §6.4 only', () => {
    const batch = {
      chatId: '5215500000001@c.us',
      messages: [exampleOfPayload('message')],
      firstSentAt: '2026-10-27T15:00:00.000Z',
      lastSentAt: '2026-10-27T15:00:01.000Z',
      count: 1
    }
    const payload = WA_EVENTS.message_batch.payload

    expect(payload.safeParse({ ...batch, reason: 'burst' }).success).toBe(true)
    expect(payload.safeParse({ ...batch, reason: 'reconcile' }).success).toBe(true)
    expect(payload.safeParse({ ...batch, reason: 'other' }).success).toBe(false)
  })

  it('message_batch holds at least one message', () => {
    const batch = {
      chatId: '5215500000001@c.us',
      messages: [],
      firstSentAt: '2026-10-27T15:00:00.000Z',
      lastSentAt: '2026-10-27T15:00:01.000Z',
      reason: 'burst'
    }

    expect(WA_EVENTS.message_batch.payload.safeParse({ ...batch, count: 0 }).success).toBe(false)
  })

  // wwebjs passes revoked_msg only when it could capture it: it can be missing, null or a message
  it.each([
    ['missing', undefined],
    ['null', null],
    ['a message', exampleOfPayload('message')]
  ])('message_revoke_everyone accepts the revoked message %s', (_label, revokedMessage) => {
    const data = { message: exampleOfPayload('message'), revokedMessage }

    expect(WA_EVENTS.message_revoke_everyone.payload.safeParse(data).success).toBe(true)
  })

  it('the events that carry no data take an empty object', () => {
    for (const name of ['authenticated', 'ready', 'remote_session_saved', 'ping'] as const) {
      expect(WA_EVENTS[name].payload.safeParse({}).success).toBe(true)
    }
  })
})

describe('eventEnvelope', () => {
  const envelope = {
    id: 'evt_0f3c9a52-7d1e-4c0b-9a55-2f1d6e8b3a10',
    event: 'qr',
    sessionId: 'support-line',
    seq: 1042,
    timestamp: '2026-10-27T15:04:05.123Z',
    data: { qr: '1@abc' }
  }

  it('accepts the envelope of its event', () => {
    expect(eventEnvelope('qr').safeParse(envelope).success).toBe(true)
  })

  it.each([
    ['another event', { event: 'code' }],
    ['the data of another event', { data: { code: 'ABCD1234' } }],
    ['an id without the evt_ prefix', { id: '0f3c9a52' }],
    ['a session id with a space', { sessionId: 'support line' }],
    ['a session id of 65 characters', { sessionId: 'a'.repeat(65) }],
    ['a seq with decimals', { seq: 1.5 }],
    ['a seq of zero', { seq: 0 }],
    ['a timestamp that is not ISO', { timestamp: 'yesterday' }]
  ])('rejects %s', (_label, override) => {
    expect(eventEnvelope('qr').safeParse({ ...envelope, ...override }).success).toBe(false)
  })

  it.each(WA_EVENT_NAMES)('builds the envelope of %s from its own schema', (name: WaEventName) => {
    const { $defs, ...top } = z.toJSONSchema(eventEnvelope(name)) as z.core.JSONSchema.JSONSchema

    const result = eventEnvelope(name).safeParse(exampleOf(top, $defs ?? {}))

    expect(result.error?.issues).toBeUndefined()
  })
})
