import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { WaDisconnectedError, WaOperationError } from '../../src/whatsapp/wa-errors.js'
import type { ClientEvent } from '../../src/whatsapp/whatsapp-client.port.js'

import {
  FakeNotScriptedError,
  FakeWhatsAppClient,
  FakeWhatsAppClientFactory,
  buildMessageDto
} from './fake-whatsapp-client.js'

// Every method of the interface, read from the source: the `implements` clause fails the build when
// one is missing, and this proves at runtime that none is left as a non-function
function portMethodNames(): string[] {
  const source = readFileSync(join(__dirname, '../../src/whatsapp/whatsapp-client.port.ts'), 'utf8')
  const body = /export interface WhatsAppClientPort \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map(match => match[1] ?? '')
}

const LIFECYCLE = [
  'initialize',
  'destroy',
  'logout',
  'resetState',
  'getState',
  'getWWebVersion',
  'requestPairingCode',
  'cancelPairingCode'
]

const READY: ClientEvent = { event: 'ready', data: {} }

describe('FakeWhatsAppClient', () => {
  it('implements every method of the port, each one through the shared plumbing', async () => {
    const names = portMethodNames()
    // A regex that silently lost methods must not pass: pin the multi-line ones and both ends
    expect(names).toEqual(
      expect.arrayContaining([
        'initialize',
        'sendChannelMessage',
        'saveOrEditAddressbookContact',
        'createGroup',
        'rejectCall'
      ])
    )
    expect(names.length).toBeGreaterThan(125)
    const fake = new FakeWhatsAppClient().disconnect()
    const method = (name: string): (() => Promise<unknown>) => {
      const fn: unknown = Reflect.get(fake, name)
      if (typeof fn !== 'function') throw new Error(`${name} is not a function`)
      return fn as () => Promise<unknown>
    }
    for (const name of names.filter(n => n !== 'onEvent' && !LIFECYCLE.includes(n))) {
      // Rejecting with WaDisconnectedError and recording proves the method goes through stub()
      await expect(method(name)()).rejects.toBeInstanceOf(WaDisconnectedError)
    }
    expect(fake.calls.map(call => call.method as string)).toEqual(
      names.filter(n => n !== 'onEvent' && !LIFECYCLE.includes(n))
    )
  })

  describe('calls', () => {
    it('records the method and the arguments of each call', async () => {
      const fake = new FakeWhatsAppClient()
      await fake.sendSeen('a@c.us')
      await fake.muteChat('a@c.us', new Date(5000))
      expect(fake.calls.map(call => call.method)).toEqual(['sendSeen', 'muteChat'])
      expect(fake.callsOf('sendSeen')[0]?.args).toEqual(['a@c.us'])
    })
  })

  describe('defaults', () => {
    it('answers flags with true, lists with [] and lookups with null', async () => {
      const fake = new FakeWhatsAppClient()
      await expect(fake.archiveChat('a@c.us')).resolves.toBe(true)
      await expect(fake.getChats()).resolves.toEqual([])
      await expect(fake.getContactAbout('a@c.us')).resolves.toBeNull()
      await expect(fake.getNumberId('5215500000009')).resolves.toBe('5215500000009@c.us')
    })

    it('answers a send with a message from us in that chat, with a fresh id each time', async () => {
      const fake = new FakeWhatsAppClient()
      const first = await fake.sendMessage('b@c.us', { type: 'text', body: 'hola' })
      const second = await fake.sendMessage('b@c.us', { type: 'text', body: 'hola' })
      expect(first).toMatchObject({ chatId: 'b@c.us', to: 'b@c.us', body: 'hola', fromMe: true })
      expect(second.id).not.toBe(first.id)
      await expect(fake.getMessageById(first.id)).resolves.toEqual(first)
      await expect(fake.getMessageById('missing')).resolves.toBeNull()
    })

    it('marks a media send as media', async () => {
      const fake = new FakeWhatsAppClient()
      const message = await fake.sendMessage('b@c.us', {
        type: 'media',
        media: { mimetype: 'image/png', data: 'AAAA' }
      })
      expect(message).toMatchObject({ hasMedia: true, type: 'image', body: '' })
    })

    it('throws FakeNotScriptedError for a DTO nobody described', async () => {
      const fake = new FakeWhatsAppClient()
      await expect(fake.getChatById('a@c.us')).rejects.toBeInstanceOf(FakeNotScriptedError)
    })
  })

  describe('script and failNext', () => {
    it('goes back to the default answer after unscript', async () => {
      const fake = new FakeWhatsAppClient()
      await fake.initialize()
      fake.script('getPollVotes', () => [
        { voter: 'a', selectedOptions: [], interactedAtTs: 1, parentMessageId: 'm' }
      ])
      expect(await fake.getPollVotes('m')).toHaveLength(1)

      fake.unscript('getPollVotes')

      expect(await fake.getPollVotes('m')).toEqual([])
    })

    it('uses the script instead of the default', async () => {
      const fake = new FakeWhatsAppClient()
      fake.script('getContactAbout', id => `about ${id}`)
      await expect(fake.getContactAbout('a@c.us')).resolves.toBe('about a@c.us')
    })

    it('lets a script describe a DTO method', async () => {
      const fake = new FakeWhatsAppClient()
      const message = buildMessageDto({ body: 'quoted' })
      fake.script('getQuotedMessage', () => message)
      await expect(fake.getQuotedMessage('x')).resolves.toBe(message)
    })

    it('rejects the next N calls with the queued error, then recovers', async () => {
      const fake = new FakeWhatsAppClient()
      const error = new WaOperationError('sendMessage', 'boom')
      fake.failNext('sendMessage', error, 2)
      const content = { type: 'text', body: 'x' } as const
      await expect(fake.sendMessage('a@c.us', content)).rejects.toBe(error)
      await expect(fake.sendMessage('a@c.us', content)).rejects.toBe(error)
      await expect(fake.sendMessage('a@c.us', content)).resolves.toMatchObject({ body: 'x' })
    })

    it('still records a call that failed', async () => {
      const fake = new FakeWhatsAppClient()
      fake.failNext('sendSeen', new WaOperationError('sendSeen'))
      await expect(fake.sendSeen('a@c.us')).rejects.toBeInstanceOf(WaOperationError)
      expect(fake.callsOf('sendSeen')).toHaveLength(1)
    })
  })

  describe('connection', () => {
    it('rejects with WaDisconnectedError (not dispatched) while disconnected', async () => {
      const fake = new FakeWhatsAppClient().disconnect()
      const error: unknown = await fake.sendSeen('a@c.us').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(WaDisconnectedError)
      expect(error).toMatchObject({ operation: 'sendSeen', dispatched: false })
      fake.reconnect()
      await expect(fake.sendSeen('a@c.us')).resolves.toBe(true)
    })

    it('keeps the lifecycle calls working while disconnected', async () => {
      const fake = new FakeWhatsAppClient().disconnect()
      await expect(fake.getState()).resolves.toBeNull()
      await expect(fake.getWWebVersion()).resolves.toEqual(expect.any(String))
      await fake.initialize()
      await expect(fake.getState()).resolves.toBe('CONNECTED')
    })

    it('disconnects on destroy and on logout', async () => {
      const destroyed = new FakeWhatsAppClient()
      await destroyed.destroy()
      await expect(destroyed.getChats()).rejects.toBeInstanceOf(WaDisconnectedError)

      const loggedOut = new FakeWhatsAppClient()
      await loggedOut.logout()
      await expect(loggedOut.getChats()).rejects.toBeInstanceOf(WaDisconnectedError)
    })
  })

  describe('events', () => {
    it('delivers to every listener and stops after unsubscribe', () => {
      const fake = new FakeWhatsAppClient()
      const first: ClientEvent[] = []
      const second: ClientEvent[] = []
      const stop = fake.onEvent(event => first.push(event))
      fake.onEvent(event => second.push(event))
      fake.emit(READY)
      stop()
      fake.emit(READY)
      expect(first).toEqual([READY])
      expect(second).toEqual([READY, READY])
      expect(fake.listenerCount).toBe(1)
    })

    it('keeps delivering when a listener throws and records the error', () => {
      const fake = new FakeWhatsAppClient()
      const seen: ClientEvent[] = []
      const failure = new Error('listener bug')
      fake.onEvent(() => {
        throw failure
      })
      fake.onEvent(event => seen.push(event))
      expect(() => fake.emit(READY)).not.toThrow()
      expect(seen).toEqual([READY])
      expect(fake.listenerErrors).toEqual([failure])
    })
  })
})

describe('FakeWhatsAppClient precedence and edge cases', () => {
  const text = { type: 'text', body: 'x' } as const

  it('keeps every lifecycle call working while disconnected', async () => {
    for (const name of LIFECYCLE) {
      const fake = new FakeWhatsAppClient().disconnect()
      const fn: unknown = Reflect.get(fake, name)
      await expect((fn as () => Promise<unknown>).call(fake)).resolves.not.toBeInstanceOf(Error)
    }
    const fake = new FakeWhatsAppClient().disconnect()
    await expect(fake.getClientInfo()).rejects.toBeInstanceOf(WaDisconnectedError)
    await expect(fake.getBatteryStatus()).rejects.toBeInstanceOf(WaDisconnectedError)
  })

  it('records a call rejected because the client is disconnected', async () => {
    const fake = new FakeWhatsAppClient().disconnect()
    await fake.sendSeen('a@c.us').catch(() => undefined)
    expect(fake.callsOf('sendSeen')).toHaveLength(1)
  })

  it('lets failNext win over a script, and only for its own method', async () => {
    const fake = new FakeWhatsAppClient()
    const error = new WaOperationError('sendSeen')
    fake.script('sendSeen', () => false).failNext('sendSeen', error)
    await expect(fake.sendSeen('a@c.us')).rejects.toBe(error)
    await expect(fake.sendSeen('a@c.us')).resolves.toBe(false)
    fake.failNext('archiveChat', error)
    await expect(fake.pinChat('a@c.us')).resolves.toBe(true)
  })

  it('does not spend a queued failure on a call rejected for being disconnected', async () => {
    const fake = new FakeWhatsAppClient()
    const error = new WaOperationError('sendSeen')
    fake.failNext('sendSeen', error).disconnect()
    await expect(fake.sendSeen('a@c.us')).rejects.toBeInstanceOf(WaDisconnectedError)
    fake.reconnect()
    await expect(fake.sendSeen('a@c.us')).rejects.toBe(error)
  })

  it('awaits an async script, propagates its errors, and replaces an earlier script', async () => {
    const fake = new FakeWhatsAppClient()
    fake.script('getContactAbout', () => Promise.resolve('first'))
    fake.script('getContactAbout', async () => {
      await Promise.resolve()
      return 'second'
    })
    await expect(fake.getContactAbout('a@c.us')).resolves.toBe('second')

    const error = new WaOperationError('getContactAbout')
    fake.script('getContactAbout', () => {
      throw error
    })
    await expect(fake.getContactAbout('a@c.us')).rejects.toBe(error)
    fake.script('getContactAbout', () => Promise.reject(error))
    await expect(fake.getContactAbout('a@c.us')).rejects.toBe(error)
  })

  it('lets a script describe a method that has no default', async () => {
    const fake = new FakeWhatsAppClient()
    const chat = { id: 'a@c.us' } as unknown as Awaited<
      ReturnType<FakeWhatsAppClient['getChatById']>
    >
    fake.script('getChatById', id => ({ ...chat, id }))
    await expect(fake.getChatById('z@c.us')).resolves.toMatchObject({ id: 'z@c.us' })
  })

  it('answers mute and unmute with the expiration it was given', async () => {
    const fake = new FakeWhatsAppClient()
    await expect(fake.muteChat('a@c.us', new Date(5000))).resolves.toEqual({
      isMuted: true,
      muteExpiration: 5
    })
    await expect(fake.muteChat('a@c.us')).resolves.toEqual({ isMuted: true, muteExpiration: -1 })
    await expect(fake.unmuteChat('a@c.us')).resolves.toEqual({ isMuted: false, muteExpiration: 0 })
  })

  it('builds the message of every kind of send with a distinct id, in order', async () => {
    const fake = new FakeWhatsAppClient()
    const sent = await fake.sendMessage('a@c.us', text)
    const channel = await fake.sendChannelMessage('c@newsletter', text)
    const reply = await fake.replyToMessage('m1', text, 'b@c.us')
    const replyDefault = await fake.replyToMessage('m1', text)
    expect(new Set([sent.id, channel.id, reply.id, replyDefault.id]).size).toBe(4)
    expect(fake.sent).toEqual([sent, channel, reply, replyDefault])
    expect(channel.chatId).toBe('c@newsletter')
    expect(reply.chatId).toBe('b@c.us')
    expect(replyDefault.chatId).toBe(buildMessageDto().chatId)
  })

  it('puts the caption of a media send in the body and replies in the chat of the original', async () => {
    const fake = new FakeWhatsAppClient()
    const media = { type: 'media', media: { mimetype: 'image/png', data: 'AAAA' } } as const
    const original = await fake.sendMessage('g@g.us', media, { caption: 'look' })
    expect(original.body).toBe('look')
    const reply = await fake.replyToMessage(original.id, text)
    expect(reply.chatId).toBe('g@g.us')
  })

  it('queues nothing for zero failures', async () => {
    const fake = new FakeWhatsAppClient()
    fake.failNext('sendSeen', new WaOperationError('sendSeen'), 0)
    await expect(fake.sendSeen('a@c.us')).resolves.toBe(true)
  })

  it('fails an unscripted DTO method with an error that is not a Wa* error', async () => {
    const error: unknown = await new FakeWhatsAppClient()
      .getChatById('a@c.us')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FakeNotScriptedError)
    expect(error).not.toBeInstanceOf(WaOperationError)
    expect(error).not.toBeInstanceOf(WaDisconnectedError)
  })

  it('answers the derived defaults from the arguments', async () => {
    const fake = new FakeWhatsAppClient()
    await expect(fake.getCountryCode('5215500000009')).resolves.toBe('52')
    await expect(fake.getFormattedNumber('5215500000009')).resolves.toBe('5215500000009')
    await expect(fake.getState()).resolves.toBe('CONNECTED')
  })

  it('applies the overrides of buildMessageDto over its defaults', () => {
    expect(buildMessageDto({ body: 'hi', fromMe: false })).toMatchObject({
      body: 'hi',
      fromMe: false,
      type: 'chat'
    })
  })

  it('delivers an event to the listeners present when it started', () => {
    const fake = new FakeWhatsAppClient()
    const late: ClientEvent[] = []
    fake.onEvent(() => {
      fake.onEvent(event => late.push(event))
    })
    fake.emit(READY)
    expect(late).toEqual([])
    expect(fake.listenerCount).toBe(2)
  })

  it('tolerates emitting with no listeners, a double unsubscribe and a non-Error throw', () => {
    const fake = new FakeWhatsAppClient()
    expect(() => fake.emit(READY)).not.toThrow()
    const stop = fake.onEvent(() => {
      throw 'plain string' // eslint-disable-line @typescript-eslint/only-throw-error
    })
    fake.emit(READY)
    expect(fake.listenerErrors).toEqual(['plain string'])
    stop()
    expect(() => stop()).not.toThrow()
    expect(fake.listenerCount).toBe(0)
  })
})

describe('FakeWhatsAppClientFactory', () => {
  it('creates a client per call with the session id and options, and finds the newest', () => {
    const factory = new FakeWhatsAppClientFactory()
    const options = { pairWithPhoneNumber: { phoneNumber: '5215500000001' } }
    const first = factory.create('s1', options)
    const restarted = factory.create('s1', {})
    factory.create('s2', {})
    expect(first).toMatchObject({ sessionId: 's1', options })
    expect(factory.clients).toHaveLength(3)
    expect(factory.clientFor('s1')).toBe(restarted)
    expect(factory.clientFor('none')).toBeUndefined()
    expect(new FakeWhatsAppClient()).toMatchObject({ sessionId: 'fake-session', options: {} })
  })
})
