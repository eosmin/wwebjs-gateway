import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { PIN_DURATIONS } from '../types/messages.dto.js'

// The patch in patches/whatsapp-web.js@1.34.8.patch (TDD §2.5) is what makes the library work with
// the current WhatsApp Web. These tests fail when a dependency refresh drops it. The library is
// read as files, not imported: only the adapter may import it.
const libraryRoot = join(process.cwd(), 'node_modules/whatsapp-web.js/src')

describe('the patched whatsapp-web.js', () => {
  const source = (file: string): string => readFileSync(join(libraryRoot, file), 'utf8')

  // The code the library sends to WhatsApp Web cannot run in Jest, so it runs here with a fake
  // `window`: `modules` is what `window.require` answers, and the helpers of the library are the
  // real ones (`LoadUtils` is the function the library injects into the page)
  const VERSION = '2.3000.1054303363'
  const evaluateHere = (fn: (...args: unknown[]) => unknown, ...args: unknown[]): unknown =>
    fn(...args)
  const withPage = async <T>(
    modules: Record<string, unknown>,
    run: () => Promise<T>
  ): Promise<T> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library
    const { LoadUtils } = require(join(libraryRoot, 'util/Injected/Utils.js')) as {
      LoadUtils: () => void
    }
    const target = globalThis as { window?: unknown }
    const before = target.window
    target.window = {
      require: (name: string) => modules[name],
      Debug: { VERSION },
      crypto: { getRandomValues: (bytes: Uint8Array) => bytes }
    }
    try {
      LoadUtils()
      return await run()
    } finally {
      target.window = before
    }
  }
  const pageOf = (): { WWebJS: Record<string, unknown> } =>
    (globalThis as unknown as { window: { WWebJS: Record<string, unknown> } }).window

  // 1.34.8 reads the key of a message as `_serialized || $1` everywhere (upstream #201832), which is
  // what our own fallback did in 1.34.7. The patch keeps only the one spot upstream missed, so these
  // tests fail when a refresh brings back a bare `_serialized` read on a key from the page
  it('never reads _serialized from a key inside the page without the $1 fallback', () => {
    const unguarded: Record<string, RegExp[]> = {
      'util/Injected/Utils.js': [
        /newMsgKey\._serialized(?! \|\| )/,
        /\bmsg\.id\._serialized(?! \|\| | == null)/,
        /lastReceivedKey\._serialized(?! \|\| )/
      ],
      'Client.js': [/parentMsgKey\._serialized(?! \|\| )/],
      'structures/Message.js': [/\bmsg\.id\._serialized(?! \|\| )/]
    }

    for (const [file, patterns] of Object.entries(unguarded)) {
      for (const pattern of patterns) expect(source(file)).not.toMatch(pattern)
    }
  })

  // The peer of an incoming call (#42) is the one fallback of ours left in Client.js
  it('keeps the peer fallback of the incoming call hook', () => {
    expect(
      source('Client.js').match(/peer\._serialized \?\? peer\.\$1 \?\? String\(peer\)/g)
    ).toHaveLength(1)
  })

  // `Message.js` edits an event message: the id of the page message has `$1` and may lack `_serialized`
  it('reads the edited event message by its $1 key too', () => {
    expect(source('structures/Message.js')).toMatch(
      /Msg\.get\(\(msg\.id\._serialized \|\| msg\.id\.\$1\)\)/
    )
  })

  // WhatsApp Web loads the module of `createGroup` lazily (F9, upstream PR #201950 is open). The page
  // code cannot run in Jest, so `Client.createGroup` runs here with a fake `window`
  describe('Client.createGroup', () => {
    type CreateGroup = (
      this: unknown,
      title: string,
      participants: string[],
      options: object
    ) => Promise<unknown>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const { prototype } = require(join(libraryRoot, 'Client.js')) as {
      prototype: { createGroup: CreateGroup }
    }
    const created = {
      title: 'g',
      wid: { _serialized: 'g@g.us' },
      participants: [],
      subject: 'g'
    }
    // Runs the function the library hands to `pupPage.evaluate` with `window` replaced
    const create = async (modules: Record<string, unknown>): Promise<unknown> =>
      withPage(modules, () =>
        prototype.createGroup.call({ pupPage: { evaluate: evaluateHere } }, 'g', [], {})
      )

    it('loads the lazy bundle before it asks for the module that creates the group', async () => {
      const modules: Record<string, unknown> = {}
      const requireBundle = jest.fn(() => {
        modules.WAWebGroupCreateJob = { createGroup: () => Promise.resolve(created) }
        return Promise.resolve()
      })
      modules.WAWebNewGroupFlowLoadable = { requireBundle }

      await expect(create(modules)).resolves.toMatchObject({ title: 'g' })
      expect(requireBundle).toHaveBeenCalledTimes(1)
    })

    it('does not load the bundle when the module is already there', async () => {
      const requireBundle = jest.fn()
      const modules = {
        WAWebGroupCreateJob: { createGroup: () => Promise.resolve(created) },
        WAWebNewGroupFlowLoadable: { requireBundle }
      }

      await create(modules)

      expect(requireBundle).not.toHaveBeenCalled()
    })

    it('answers the missing module and the build when the bundle does not bring it', async () => {
      const modules = { WAWebNewGroupFlowLoadable: { requireBundle: () => Promise.resolve() } }

      const answer = await create(modules)

      expect(answer).toEqual(expect.stringContaining('CreateGroupError'))
      expect(answer).toEqual(
        expect.stringContaining(
          `[lazy-module] WAWebGroupCreateJob is not available in WhatsApp Web ${VERSION} (its bundle WAWebNewGroupFlowLoadable did not load it)`
        )
      )
    })

    it('keeps the cause of a failure in the text it answers, not only the library generic', async () => {
      const modules = {
        WAWebNewGroupFlowLoadable: {
          requireBundle: () => Promise.reject(new Error('bundle offline'))
        }
      }

      const answer = await create(modules)

      expect(answer).toEqual(expect.stringContaining('CreateGroupError'))
      expect(answer).toEqual(expect.stringContaining('bundle offline'))
    })
  })

  // F14: WhatsApp Web 2.3000.1054303363 answers `undefined` to window.require(name) for modules that
  // nobody loaded yet, so forward, acceptGroupV4Invite, setDisplayName, revokeStatusMessage and the
  // call link failed with 502 and no cause. The bundle that loads each one was found by probing a page
  // (docs/sessions.md); a module that is still missing must fail with its name and the version
  describe('modules that WhatsApp Web loads lazily', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const { prototype } = require(join(libraryRoot, 'Client.js')) as {
      prototype: Record<
        | 'acceptGroupV4Invite'
        | 'setDisplayName'
        | 'revokeStatusMessage'
        | 'createCallLink'
        | 'acceptInvite'
        | 'demoteChannelAdmin'
        | 'transferChannelOwnership',
        (...args: unknown[]) => Promise<unknown>
      >
    }
    const evaluate = { pupPage: { evaluate: evaluateHere } }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const groupChat = require(join(libraryRoot, 'structures/GroupChat.js')) as {
      prototype: { getInviteCode: (this: unknown) => Promise<unknown> }
    }

    interface LazyCase {
      method: string
      module: string
      loadable: string | null
      // the other modules the page code needs, and the call of the library
      others: Record<string, unknown>
      action: string
      // what the action answers when the library reads it (default 'done')
      answer?: unknown
      call: () => Promise<unknown>
    }
    const cases: LazyCase[] = [
      {
        method: 'acceptGroupV4Invite',
        module: 'WAWebGroupInviteV4Job',
        loadable: 'WAWebInfoFlowLoadable',
        others: { WAWebWidFactory: { createWid: (id: string) => id } },
        action: 'joinGroupViaInviteV4',
        call: () =>
          prototype.acceptGroupV4Invite.call(evaluate, {
            groupId: 'g@g.us',
            fromId: 'f@c.us',
            inviteCode: 'code',
            inviteCodeExp: 1
          })
      },
      {
        method: 'setDisplayName',
        module: 'WAWebSetPushnameConnAction',
        loadable: 'WAWebProfileDrawerLoadableRequireBundle',
        others: { WAWebConnModel: { Conn: { canSetMyPushname: () => true } } },
        action: 'setPushname',
        call: () => prototype.setDisplayName.call(evaluate, 'name')
      },
      {
        method: 'revokeStatusMessage',
        module: 'WAWebRevokeStatusAction',
        loadable: 'WAWebStatusQuotedFlowLoadable',
        others: {
          WAWebCollections: {
            Status: { getMyStatus: () => ({}) },
            Msg: { get: () => ({ id: { fromMe: true, remote: { isStatus: () => true } } }) }
          }
        },
        action: 'sendStatusRevokeMsgAction',
        call: () => prototype.revokeStatusMessage.call(evaluate, 'status-id')
      },
      {
        method: 'forwardMessage',
        module: 'WAWebChatForwardMessage',
        loadable: 'WAWebForwardMessageFlowLoadable',
        others: { WAWebCollections: { Msg: { get: () => ({}) } } },
        action: 'forwardMessages',
        call: () => {
          const forward = pageOf().WWebJS.forwardMessage as (
            c: string,
            m: string
          ) => Promise<unknown>
          // forwardMessage reads window.WWebJS.getChat when it runs: the stub replaces the real one
          pageOf().WWebJS.getChat = () => Promise.resolve({})
          return forward('c@c.us', 'm')
        }
      },
      {
        method: 'createCallLink',
        module: 'WAWebGenerateEventCallLink',
        loadable: null,
        others: {},
        action: 'createEventCallLink',
        call: () => prototype.createCallLink.call(evaluate, new Date(), 'video')
      },
      // F14b: the same drift in the group invite, the channel admin and the channel owner modules
      {
        method: 'acceptInvite',
        module: 'WAWebGroupInviteJob',
        loadable: 'WAWebCommunityFlowLoadable',
        others: {},
        action: 'joinGroupViaInvite',
        answer: { gid: { _serialized: 'g@g.us' } },
        call: () => prototype.acceptInvite.call(evaluate, 'code')
      },
      {
        method: 'getInviteCode',
        module: 'WAWebMexFetchGroupInviteCodeJob',
        loadable: 'WAWebCommunityFlowLoadable',
        others: {},
        action: 'fetchMexGroupInviteCode',
        answer: { code: 'abc' },
        call: () =>
          groupChat.prototype.getInviteCode.call({
            client: evaluate,
            id: { _serialized: 'g@g.us' }
          })
      },
      {
        method: 'demoteChannelAdmin',
        module: 'WAWebDemoteNewsletterAdminAction',
        loadable: 'WAWebGroupMembershipApprovalRequestsFlowLoadable',
        others: { WAWebWidFactory: { createWid: (id: string) => id } },
        action: 'demoteNewsletterAdmin',
        call: () => prototype.demoteChannelAdmin.call(evaluate, 'c@newsletter', 'u@c.us')
      },
      {
        method: 'transferChannelOwnership',
        module: 'WAWebChangeNewsletterOwnerAction',
        loadable: 'WAWebGroupMembershipApprovalRequestsFlowLoadable',
        others: { WAWebCollections: { Contact: { get: () => ({}) } } },
        action: 'changeNewsletterOwnerAction',
        call: () => {
          pageOf().WWebJS.getChat = () => Promise.resolve({ id: 'c', newsletterMetadata: {} })
          return prototype.transferChannelOwnership.call(evaluate, 'c@newsletter', 'u@c.us')
        }
      }
    ]

    // The module and the bundle are what the page answers: `bundleLoads` says what loading the bundle does
    const run = (
      c: LazyCase,
      state: { present: boolean; bundle: 'loads' | 'does-nothing' | 'absent' | 'throws' }
    ): { action: jest.Mock; requireBundle: jest.Mock; result: Promise<unknown> } => {
      const action = jest.fn(() => Promise.resolve(c.answer ?? 'done'))
      const lazy = { [c.action]: action }
      const modules: Record<string, unknown> = { ...c.others }
      if (state.present) modules[c.module] = lazy
      const requireBundle = jest.fn(() => {
        if (state.bundle === 'throws') return Promise.reject(new Error('bundle offline'))
        if (state.bundle === 'loads') modules[c.module] = lazy
        return Promise.resolve()
      })
      if (c.loadable && state.bundle !== 'absent') modules[c.loadable] = { requireBundle }
      const result = withPage(modules, c.call)
      return { action, requireBundle, result }
    }

    const withLoadable = cases.filter(c => c.loadable)

    it.each(withLoadable.map(c => [c.method, c] as const))(
      '%s loads the bundle of its module when the module is not there yet',
      async (_name, c) => {
        const { action, requireBundle, result } = run(c, { present: false, bundle: 'loads' })

        await result
        expect(requireBundle).toHaveBeenCalledTimes(1)
        expect(action).toHaveBeenCalledTimes(1)
      }
    )

    it.each(cases.map(c => [c.method, c] as const))(
      '%s does not load any bundle when the module is already there',
      async (_name, c) => {
        const { action, requireBundle, result } = run(c, { present: true, bundle: 'loads' })

        await result
        expect(requireBundle).not.toHaveBeenCalled()
        expect(action).toHaveBeenCalledTimes(1)
      }
    )

    it.each(cases.map(c => [c.method, c] as const))(
      '%s fails naming the module and the WhatsApp Web version when the module is still missing',
      async (_name, c) => {
        const { action, result } = run(c, { present: false, bundle: 'does-nothing' })

        await expect(result).rejects.toThrow(
          new RegExp(`\\[lazy-module\\] ${c.module} is not available in WhatsApp Web ${VERSION}`)
        )
        expect(action).not.toHaveBeenCalled()
      }
    )

    it.each(withLoadable.map(c => [c.method, c] as const))(
      '%s names the bundle that did not load the module',
      async (_name, c) => {
        const { result } = run(c, { present: false, bundle: 'does-nothing' })

        await expect(result).rejects.toThrow(`its bundle ${c.loadable} did not load it`)
      }
    )

    it.each(withLoadable.map(c => [c.method, c] as const))(
      '%s fails clearly when the bundle itself is not in the page',
      async (_name, c) => {
        const { result } = run(c, { present: false, bundle: 'absent' })

        await expect(result).rejects.toThrow(
          `[lazy-module] ${c.module} is not available in WhatsApp Web ${VERSION} (its bundle ${c.loadable} did not load it)`
        )
      }
    )

    it.each(withLoadable.map(c => [c.method, c] as const))(
      '%s names the module and the build when the bundle fails to load',
      async (_name, c) => {
        const { result } = run(c, { present: false, bundle: 'throws' })

        await expect(result).rejects.toThrow(
          `[lazy-module] ${c.module} is not available in WhatsApp Web ${VERSION} (its bundle ${c.loadable} failed to load: bundle offline)`
        )
      }
    )

    it('says that no bundle is known when the call link module is missing', async () => {
      const link = cases.find(c => c.method === 'createCallLink') as LazyCase
      const { result } = run(link, { present: false, bundle: 'absent' })

      await expect(result).rejects.toThrow('no bundle is known to load it')
    })

    it.each(cases.map(c => [c.method, c] as const))(
      '%s treats a module the page answers null for as missing, before and after the bundle',
      async (_name, c) => {
        const modules: Record<string, unknown> = { ...c.others, [c.module]: null }
        if (c.loadable) modules[c.loadable] = { requireBundle: () => Promise.resolve() }

        await expect(withPage(modules, c.call)).rejects.toThrow(`${c.module} is not available`)
      }
    )

    it('does not fail on a bundle without requireBundle: it only reports the module as missing', async () => {
      const c = cases[1] as LazyCase
      const modules = { ...c.others, [c.loadable as string]: {} }

      await expect(withPage(modules, c.call)).rejects.toThrow(`${c.module} is not available`)
    })

    it('says "unknown" when the page has no build number', async () => {
      const c = cases[1] as LazyCase
      const target = globalThis as { window?: { Debug?: unknown } }

      await expect(
        withPage(c.others, async () => {
          delete target.window?.Debug
          return c.call()
        })
      ).rejects.toThrow(`WhatsApp Web unknown`)
    })

    // The send of an event with a call link (`callType` other than `none`) reaches the same module;
    // sendMessage is too big to run here, so the call is pinned in the source
    it('asks for the module of the event call link through the helper', () => {
      expect(source('util/Injected/Utils.js')).toMatch(
        /requireLazyModule\(\s*'WAWebGenerateEventCallLink',?\s*\)/
      )
    })
  })

  // F30 (H-LIVE-11): the library rejected a call by writing a `call/reject` stanza by hand and
  // sending it without waiting for an answer, so the gateway said "done" while the phone kept
  // ringing. WhatsApp Web rejects through its VoIP stack, which owns the state of the call. The
  // stack acts on the call it holds, not on an id, so the patch checks the call first and then
  // looks at whether it went away
  describe('rejecting an incoming call', () => {
    const SELF = 7
    type Stack = Record<string, unknown>
    type Outcome = { result: string; confirmed?: boolean }
    type Page = { modules: Record<string, unknown>; listed: Set<string> }
    // `listed` is what the call collection of the page answers to `get`
    const page = (
      stack: Stack | null,
      calls: { listed?: string[]; active?: string | null } = {}
    ): Page => {
      const listed = new Set(calls.listed ?? ['c1'])
      return {
        listed,
        modules: {
          WAWebVoipStackInterface: { getVoipStackInterface: () => Promise.resolve(stack) },
          WAWebCallCollection: {
            get: (id: string): unknown => (listed.has(id) ? { id } : undefined),
            get activeCall(): unknown {
              return calls.active == null ? null : { id: calls.active }
            }
          },
          WAWebVoipWaCallEnums: { RejectEndReason: { Self: SELF } },
          // the old way: the test fails when the patch still reaches for it
          WADeprecatedSendIq: {
            deprecatedCastStanza: () => {
              throw new Error('a stanza was written by hand')
            }
          }
        }
      }
    }
    // a stack whose reject makes the call leave the collection, as a real one should
    const rejectingStack = (p: Page, name: string, fn = jest.fn()): Stack => {
      fn.mockImplementation(() => {
        p.listed.delete('c1')
        return Promise.resolve()
      })
      return { type: 'web', [name]: fn }
    }
    const reject = (p: Page, id = 'c1'): Promise<Outcome> =>
      withPage(p.modules, () =>
        (pageOf().WWebJS.rejectCall as (peer: string, id: string) => Promise<Outcome>)(
          'peer@lid',
          id
        )
      )

    it('rejects through the stack with the reason the page uses itself, and confirms when the call is gone', async () => {
      const p = page(null)
      const withReason = jest.fn()
      p.modules['WAWebVoipStackInterface'] = {
        getVoipStackInterface: () =>
          Promise.resolve(rejectingStack(p, 'rejectCallWithEndReason', withReason))
      }

      await expect(reject(p)).resolves.toEqual({ result: 'rejected', confirmed: true })
      expect(withReason).toHaveBeenCalledTimes(1)
      expect(withReason).toHaveBeenCalledWith(SELF)
    })

    it('uses rejectCall() when the stack has no rejectCallWithEndReason', async () => {
      const p = page(null)
      const plain = jest.fn()
      p.modules['WAWebVoipStackInterface'] = {
        getVoipStackInterface: () => Promise.resolve(rejectingStack(p, 'rejectCall', plain))
      }

      await expect(reject(p)).resolves.toEqual({ result: 'rejected', confirmed: true })
      expect(plain).toHaveBeenCalledTimes(1)
    })

    it('says the call is gone, without touching the stack, when the page lists no such call', async () => {
      const withReason = jest.fn(() => Promise.resolve())
      const p = page({ type: 'web', rejectCallWithEndReason: withReason }, { listed: [] })

      await expect(reject(p)).resolves.toEqual({ result: 'gone' })
      expect(withReason).not.toHaveBeenCalled()
    })

    it('refuses to reject when another call is the one the stack holds', async () => {
      const withReason = jest.fn(() => Promise.resolve())
      const p = page(
        { type: 'web', rejectCallWithEndReason: withReason },
        { listed: ['c1', 'c2'], active: 'c2' }
      )

      await expect(reject(p)).rejects.toThrow(/\[call-reject\].*another call/)
      expect(withReason).not.toHaveBeenCalled()
    })

    it.each([
      ['there is no stack', null],
      ['the stack is not the web one', { type: 'native', rejectCall: () => Promise.resolve() }],
      ['it has no function to reject with', { type: 'web', endCall: () => Promise.resolve() }]
    ])('fails with [call-reject] when %s', async (_name, stack) => {
      await expect(reject(page(stack as Stack | null))).rejects.toThrow(
        /\[call-reject\].*WhatsApp Web 2\.3000/
      )
    })

    it('names the stack functions it did find, so that a changed build can be read from the log', async () => {
      const p = page({ type: 'web', endCall: () => Promise.resolve(), screenCall: () => 0 })

      await expect(reject(p)).rejects.toThrow(/endCall/)
    })

    it('does not claim it when the call is still listed after the wait', async () => {
      jest.useFakeTimers()
      try {
        const withReason = jest.fn(() => Promise.resolve())
        const pending = reject(page({ type: 'web', rejectCallWithEndReason: withReason }))
        await jest.advanceTimersByTimeAsync(5000)

        await expect(pending).resolves.toEqual({ result: 'rejected', confirmed: false })
        expect(withReason).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })

    it('confirms as soon as the call leaves, without waiting the whole time', async () => {
      jest.useFakeTimers()
      try {
        const p = page({ type: 'web', rejectCallWithEndReason: () => Promise.resolve() })
        let done = false
        const pending = reject(p).then(outcome => {
          done = true
          return outcome
        })
        await jest.advanceTimersByTimeAsync(250)
        p.listed.delete('c1')
        await jest.advanceTimersByTimeAsync(250)

        expect(done).toBe(true)
        await expect(pending).resolves.toEqual({ result: 'rejected', confirmed: true })
      } finally {
        jest.useRealTimers()
      }
    })

    it('does not write the stanza by hand any more', () => {
      const utils = source('util/Injected/Utils.js')
      const start = utils.indexOf('window.WWebJS.rejectCall')
      const end = utils.indexOf('window.WWebJS.', start + 10)

      expect(start).toBeGreaterThan(-1)
      expect(utils.slice(start, end)).not.toMatch(/deprecatedCastStanza|WAWap/)
    })

    it('hands the answer of the page back from Call.reject', () => {
      expect(source('structures/Call.js')).toMatch(/return this\.client\.pupPage\.evaluate/)
    })
  })

  // F14b: WhatsApp Web 2.3000.1054320313 removed `canCheckStatusRankingPosterGating` from
  // WAWebStatusGatingUtils (posting a status failed with "is not a function") and moved
  // `getRoleByIdentifier` from WAWebNewsletterModelUtils to WAWebNewsletterRoleIdentifier. The
  // library reads both inside the page, so the patch asks through helpers that survive a rename
  describe('members that WhatsApp Web moved or removed', () => {
    type Helper = (...args: unknown[]) => unknown
    const helper = (name: string): Helper => pageOf().WWebJS[name] as Helper

    describe('cannotBeRanked (a status posted by the account)', () => {
      it('answers what WhatsApp Web says while the gating function exists', async () => {
        const modules = {
          WAWebStatusGatingUtils: { canCheckStatusRankingPosterGating: () => true }
        }

        await expect(
          withPage(modules, () => Promise.resolve(helper('cannotBeRanked')()))
        ).resolves.toBe(true)
      })

      it.each([
        ['the function was removed', { WAWebStatusGatingUtils: {} }],
        ['the module is not there', {}],
        ['the module is null', { WAWebStatusGatingUtils: null }]
      ])('answers false and does not throw when %s', async (_name, modules) => {
        await expect(
          withPage(modules, () => Promise.resolve(helper('cannotBeRanked')()))
        ).resolves.toBe(false)
      })

      it('is what sendMessage passes for a status, never a direct call of the removed function', () => {
        const utils = source('util/Injected/Utils.js')

        expect(utils).toMatch(/cannotBeRanked:\s*window\.WWebJS\.cannotBeRanked\(\)/)
        expect(utils.match(/\.canCheckStatusRankingPosterGating\(\)/g)).toHaveLength(1)
      })
    })

    describe('getRoleByIdentifier (the metadata of a channel by its invite)', () => {
      const role = (modules: Record<string, unknown>): Promise<unknown> =>
        withPage(modules, () => Promise.resolve(helper('getRoleByIdentifier')('code')))

      it('asks the module it moved to', async () => {
        await expect(
          role({
            WAWebNewsletterRoleIdentifier: { getRoleByIdentifier: (c: string) => `new:${c}` }
          })
        ).resolves.toBe('new:code')
      })

      it('still asks the old module on a build that did not move it', async () => {
        await expect(
          role({ WAWebNewsletterModelUtils: { getRoleByIdentifier: (c: string) => `old:${c}` } })
        ).resolves.toBe('old:code')
      })

      it('prefers the new module when both have it', async () => {
        await expect(
          role({
            WAWebNewsletterRoleIdentifier: { getRoleByIdentifier: () => 'new' },
            WAWebNewsletterModelUtils: { getRoleByIdentifier: () => 'old' }
          })
        ).resolves.toBe('new')
      })

      it('fails naming the member and the build when neither module has it', async () => {
        await expect(role({ WAWebNewsletterModelUtils: {} })).rejects.toThrow(
          `[lazy-module] getRoleByIdentifier is not available in WhatsApp Web ${VERSION}`
        )
      })

      it('is what getChannelMetadata asks', () => {
        const utils = source('util/Injected/Utils.js')

        expect(utils).toMatch(/window\.WWebJS\.getRoleByIdentifier\(inviteCode\)/)
        expect(utils).not.toMatch(/require\('WAWebNewsletterModelUtils'\)\s*\.getRoleByIdentifier/)
      })
    })
  })

  // The tests run the real Client.sendMessage with a page we control: the library builds its Message
  // in Node after the page sent, and only a failure there may carry the marker
  describe('Client.sendMessage', () => {
    type SendMessage = (this: unknown, chatId: string, content: string) => Promise<unknown>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const { prototype } = require(join(libraryRoot, 'Client.js')) as {
      prototype: { sendMessage: SendMessage }
    }
    const send = async (answer: () => Promise<unknown>): Promise<unknown> => {
      const evaluate = jest.fn(answer)
      try {
        return await prototype.sendMessage.call({ pupPage: { evaluate } }, 'c@c.us', 'hola')
      } finally {
        // A failure before the page was reached would pass these tests for the wrong reason
        expect(evaluate).toHaveBeenCalledTimes(1)
      }
    }

    it('marks a failure of the Node side after the page sent the message', async () => {
      const unreadable = {
        get id(): never {
          throw new TypeError('x is undefined')
        }
      }

      const error: unknown = await send(() => Promise.resolve(unreadable)).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      expect(error).toHaveProperty('afterDispatch', true)
      expect(error).toHaveProperty('cause', expect.any(TypeError))
    })

    // Puppeteer 24 rejects with the message the page threw, with no prefix (checked against a real
    // Chrome), so the patch tags the start of the message text
    it.each([
      ['plain', '[after-dispatch] message.serialize is not a function'],
      [
        'followed by more lines',
        '[after-dispatch] message.serialize is not a function\n    at eval'
      ]
    ])(
      'marks a failure inside the page once the message was added to the chat, %s',
      async (_name, message) => {
        const rejection = new Error(message)

        const error: unknown = await send(() => Promise.reject(rejection)).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(Error)
        expect(error).toHaveProperty('afterDispatch', true)
        expect(error).toHaveProperty('cause', rejection)
      }
    )

    // A page error before the dispatch can echo what the caller sent (a file name, a quoted id)
    it.each([
      ['the tag in the middle of the text', 'bad file name [after-dispatch] x.png'],
      ['the tag after a line break', 'bad input\n[after-dispatch] a.png'],
      ['the tag behind an error class name', 'Error: [after-dispatch] x'],
      ['an error without a message', '']
    ])('leaves %s unmarked', async (_name, message) => {
      const rejection = new Error(message)

      const error: unknown = await send(() => Promise.reject(rejection)).catch((e: unknown) => e)

      expect(error).toBe(rejection)
    })

    it('answers null, not undefined, when the page found no chat and sent nothing', async () => {
      await expect(send(() => Promise.resolve(null))).resolves.toBeNull()
    })

    it('answers undefined when the page sent but returned no message', async () => {
      await expect(send(() => Promise.resolve(undefined))).resolves.toBeUndefined()
    })

    // The page code cannot run here, so the tags are pinned in the source: one for getMessageModel
    // and one for each branch of WWebJS.sendMessage (chat, channel, status). The in-page code cannot run
    // in Jest: the manual smoke test covers it
    it('tags the page code that runs once the message may have left', () => {
      const count = (file: string): number =>
        (source(file).match(/new Error\('\[after-dispatch\] '/g) ?? []).length

      expect(count('Client.js')).toBe(1)
      expect(count('util/Injected/Utils.js')).toBe(3)
      const utils = source('util/Injected/Utils.js')
      const tagged = /\} catch \(error\) \{\s*throw new Error\('\[after-dispatch\] '/.source
      expect(utils).toMatch(new RegExp(String.raw`updateNewsletterMsgRecord\(msg\);\s*` + tagged))
      expect(utils).toMatch(
        new RegExp(String.raw`\[msg, mediaUpdate\] : \[statusOptions\]\)\);\s*` + tagged)
      )
      expect(utils).toMatch(new RegExp(String.raw`await sendMsgResultPromise;\s*` + tagged))
      expect(source('Client.js')).toMatch(
        /try \{\s*return window\.WWebJS\.getMessageModel\(msg\);\s*\} catch \(error\) \{\s*throw new Error\('\[after-dispatch\] '/
      )
    })

    it('leaves a failure of the page unmarked: the message did not leave', async () => {
      const error: unknown = await send(() =>
        Promise.reject(new Error('Evaluation failed: not a chat'))
      ).catch((e: unknown) => e)

      expect(error).toHaveProperty('message', 'Evaluation failed: not a chat')
      expect(error).not.toHaveProperty('afterDispatch')
    })
  })

  // Probed against a real linked account (issue #42, F9b): on WhatsApp Web 2.3000.1052525806 an incoming
  // call reaches `WAWebCallCollection.setActiveCall(call)` and `setActiveCall(null)` ends it; on
  // 2.3000.1054292354 `setActiveCall` is not called and the call arrives as `processIncomingCall(id, wid,
  // offer)` followed by `add(call)`, once per call. The internal Map the library used to wrap is never
  // written. The page code cannot run in Jest, so the block of Client.js that installs the hooks runs
  // here against a fake `window`
  describe('the incoming call hook', () => {
    interface CallModule {
      on?: () => void
      setActiveCall?: (call: unknown, ...rest: unknown[]) => unknown
      add?: (call: unknown, ...rest: unknown[]) => unknown
      processIncomingCall?: (...args: unknown[]) => unknown
    }
    const hookSource = (): string => {
      const text = source('Client.js')
      const start = text.indexOf(
        "const WAWebCallCollection = window.require('WAWebCallCollection');"
      )
      const end = text.indexOf("Chat.on('remove'", start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      return text.slice(start, end)
    }
    // The object the probe saw (values redacted)
    const ringing = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'CALL1',
      peerJid: { _serialized: '5210000000000@c.us' },
      offerTime: 1793438493,
      isVideo: false,
      isGroup: false,
      outgoing: false,
      ...overrides
    })
    const install = (
      module: CallModule | undefined,
      onIncomingCall: (call: unknown) => unknown = () => undefined
    ): void => {
      const window = { require: () => module, onIncomingCall }
      // Date and Promise are Jest's, so fake timers reach the block
      runInNewContext(hookSource(), { window, Date, Promise })
    }
    const moduleWith = (inner: jest.Mock = jest.fn((): string => 'original')): CallModule => ({
      on: () => undefined,
      setActiveCall: inner
    })
    // The shape `add` got in a real call on 2.3000.1054292354 (values redacted): no `outgoing`
    const added = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'CALL1',
      isGroup: false,
      groupJid: null,
      peerJid: { server: 'lid', user: '1', _serialized: '1@lid' },
      isVideo: false,
      offerTime: 1793438493,
      isSilenced: false,
      offerReceivedWhileOffline: false,
      ...overrides
    })
    const moduleWithAdd = (
      add: jest.Mock = jest.fn((): string => 'added'),
      setActiveCall: jest.Mock = jest.fn()
    ): CallModule => ({ add, setActiveCall, processIncomingCall: jest.fn() })

    it('reports a call that reaches setActiveCall', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())

      expect(onIncomingCall).toHaveBeenCalledTimes(1)
      expect(onIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'CALL1',
          peerJid: '5210000000000@c.us',
          offerTime: 1793438493,
          isVideo: false,
          isGroup: false,
          outgoing: false
        })
      )
    })

    // Seen with a real call: offerTime is 0 while the call rings
    it('stamps a call with the time it arrived when WhatsApp Web has not set offerTime yet', () => {
      jest.useFakeTimers().setSystemTime(new Date(1793438493500))
      try {
        const onIncomingCall = jest.fn()
        const module = moduleWith()
        install(module, onIncomingCall)

        module.setActiveCall?.(ringing({ offerTime: 0 }))

        expect(onIncomingCall).toHaveBeenCalledWith(
          expect.objectContaining({ offerTime: 1793438493 })
        )
      } finally {
        jest.useRealTimers()
      }
    })

    it('keeps a peer id that is already a string', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing({ peerJid: '5210000000000@c.us' }))

      expect(onIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({ peerJid: '5210000000000@c.us' })
      )
    })

    it('reports no peer rather than the text "undefined" when the call has none', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing({ peerJid: undefined }))

      expect(onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({ peerJid: undefined }))
    })

    it('still runs the original setActiveCall with its arguments and answers what it answers', () => {
      const inner = jest.fn((): string => 'original')
      const module = moduleWith(inner)
      install(module)
      const call = ringing()

      const answer = module.setActiveCall?.(call, 'extra')

      expect(inner).toHaveBeenCalledWith(call, 'extra')
      expect(answer).toBe('original')
    })

    it('does not report the end of a call, which is setActiveCall(null)', () => {
      const onIncomingCall = jest.fn()
      const inner = jest.fn()
      const module = moduleWith(inner)
      install(module, onIncomingCall)

      module.setActiveCall?.(null)

      expect(onIncomingCall).not.toHaveBeenCalled()
      expect(inner).toHaveBeenCalledWith(null)
    })

    it('reports a call once, however often WhatsApp Web sets it again', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())
      module.setActiveCall?.(ringing({ isSilenced: true }))
      module.setActiveCall?.(null)
      module.setActiveCall?.(ringing({ id: 'CALL2' }))

      expect(onIncomingCall).toHaveBeenCalledTimes(2)
    })

    it('reports each call once when two calls overlap', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing({ id: 'A' }))
      module.setActiveCall?.(ringing({ id: 'B' }))
      module.setActiveCall?.(ringing({ id: 'A' }))

      expect(onIncomingCall).toHaveBeenCalledTimes(2)
    })

    it('reports a call again on the next setActiveCall when the report failed', async () => {
      const onIncomingCall = jest
        .fn()
        .mockRejectedValueOnce(new Error('binding gone'))
        .mockResolvedValue(undefined)
      const module = moduleWith()
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())
      await new Promise(resolve => setImmediate(resolve))
      module.setActiveCall?.(ringing())

      expect(onIncomingCall).toHaveBeenCalledTimes(2)
    })

    it('reports a call once even if the block that installs the hook runs twice in the page', () => {
      const onIncomingCall = jest.fn()
      const module = moduleWith()
      install(module, onIncomingCall)
      install(module, onIncomingCall)

      module.setActiveCall?.(ringing())

      expect(onIncomingCall).toHaveBeenCalledTimes(1)
    })

    it('does not let a failure of the report stop WhatsApp Web setting the call', async () => {
      const inner = jest.fn((): string => 'original')
      const module = moduleWith(inner)
      const onIncomingCall = jest.fn(() => Promise.reject(new Error('binding gone')))
      install(module, onIncomingCall)

      expect(module.setActiveCall?.(ringing())).toBe('original')
      // The hook ran: without this the test would also pass if it was never installed
      expect(onIncomingCall).toHaveBeenCalledTimes(1)
      // A rejection nobody handles would crash the page's event loop of promises
      await new Promise(resolve => setImmediate(resolve))
    })

    describe('on a build where the call arrives through add', () => {
      it('reports a call that reaches add, as an incoming one', () => {
        const onIncomingCall = jest.fn()
        const module = moduleWithAdd()
        install(module, onIncomingCall)

        module.add?.(added({ isVideo: true }))

        expect(onIncomingCall).toHaveBeenCalledTimes(1)
        expect(onIncomingCall).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'CALL1',
            peerJid: '1@lid',
            offerTime: 1793438493,
            isVideo: true,
            isGroup: false,
            outgoing: false
          })
        )
      })

      it('still runs the original add with its arguments and answers what it answers', () => {
        const add = jest.fn((): string => 'added')
        const module = moduleWithAdd(add)
        install(module)
        const call = added()

        expect(module.add?.(call, 'extra')).toBe('added')
        expect(add).toHaveBeenCalledWith(call, 'extra')
      })

      it('stamps the arrival time when offerTime is 0', () => {
        jest.useFakeTimers().setSystemTime(new Date(1793438493500))
        try {
          const onIncomingCall = jest.fn()
          const module = moduleWithAdd()
          install(module, onIncomingCall)

          module.add?.(added({ offerTime: 0 }))

          expect(onIncomingCall).toHaveBeenCalledWith(
            expect.objectContaining({ offerTime: 1793438493 })
          )
        } finally {
          jest.useRealTimers()
        }
      })

      // The order seen in a real voice call: processIncomingCall, add, three repeats of
      // processIncomingCall 1.5 s later (their isVideo is unreliable), another when the caller hangs up
      it('reports one call for the whole sequence of a real call', () => {
        const onIncomingCall = jest.fn()
        const processIncomingCall = jest.fn()
        const module = moduleWithAdd()
        module.processIncomingCall = processIncomingCall
        install(module, onIncomingCall)

        module.processIncomingCall?.('CALL1', {}, { isVideo: true })
        module.add?.(added({ isVideo: true }))
        for (let i = 0; i < 3; i++) module.processIncomingCall?.('CALL1', {}, { isVideo: false })
        module.processIncomingCall?.('CALL1', {}, { isVideo: false })

        expect(onIncomingCall).toHaveBeenCalledTimes(1)
        expect(onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({ isVideo: true }))
        expect(processIncomingCall).toHaveBeenCalledTimes(5)
      })

      it('reports a call once when a build fires both setActiveCall and add', () => {
        const onIncomingCall = jest.fn()
        const module = moduleWithAdd()
        install(module, onIncomingCall)

        module.setActiveCall?.(ringing())
        module.add?.(added())
        module.setActiveCall?.(ringing())

        expect(onIncomingCall).toHaveBeenCalledTimes(1)
      })

      it('reports a call once when add comes first and setActiveCall after', () => {
        const onIncomingCall = jest.fn()
        const module = moduleWithAdd()
        install(module, onIncomingCall)

        module.add?.(added())
        module.setActiveCall?.(ringing())

        expect(onIncomingCall).toHaveBeenCalledTimes(1)
      })

      it('reports each of two different calls', () => {
        const onIncomingCall = jest.fn()
        const module = moduleWithAdd()
        install(module, onIncomingCall)

        module.add?.(added({ id: 'A' }))
        module.add?.(added({ id: 'B' }))

        expect(onIncomingCall).toHaveBeenCalledTimes(2)
      })

      it('ignores what add gets that is not a call', () => {
        const onIncomingCall = jest.fn()
        const add = jest.fn()
        const module = moduleWithAdd(add)
        install(module, onIncomingCall)

        module.add?.(undefined)
        module.add?.('CALL1')
        module.add?.([added()])
        module.add?.({ isVideo: true })

        expect(onIncomingCall).not.toHaveBeenCalled()
        expect(add).toHaveBeenCalledTimes(4)
      })

      it('reports a call again on the next add when the report failed', async () => {
        const onIncomingCall = jest
          .fn()
          .mockRejectedValueOnce(new Error('binding gone'))
          .mockResolvedValue(undefined)
        const module = moduleWithAdd()
        install(module, onIncomingCall)

        module.add?.(added())
        await new Promise(resolve => setImmediate(resolve))
        module.add?.(added())

        expect(onIncomingCall).toHaveBeenCalledTimes(2)
      })

      it('does not let a failure of the report stop WhatsApp Web adding the call', async () => {
        const module = moduleWithAdd()
        install(
          module,
          jest.fn(() => {
            throw new Error('binding gone')
          })
        )

        expect(module.add?.(added())).toBe('added')
        await new Promise(resolve => setImmediate(resolve))
      })

      it('wraps add once even if the block runs twice in the page', () => {
        const onIncomingCall = jest.fn()
        const module = moduleWithAdd()
        install(module, onIncomingCall)
        install(module, onIncomingCall)

        module.add?.(added())

        expect(onIncomingCall).toHaveBeenCalledTimes(1)
      })

      it('hooks add alone when the module has no setActiveCall', () => {
        const onIncomingCall = jest.fn()
        const module: CallModule = { add: jest.fn() }
        install(module, onIncomingCall)

        module.add?.(added())

        expect(onIncomingCall).toHaveBeenCalledTimes(1)
      })
    })

    it('does nothing when the module is gone or has no method to hook', () => {
      expect(() => {
        install(undefined)
      }).not.toThrow()
      expect(() => {
        install({ on: () => undefined })
      }).not.toThrow()
      expect(() => {
        install({ add: undefined, setActiveCall: undefined })
      }).not.toThrow()
    })
  })

  describe('exposeFunctionIfAbsent', () => {
    type Helper = (page: FakePage, name: string, fn: () => void) => Promise<void>
    interface FakePage {
      evaluate: jest.Mock<Promise<boolean>, []>
      exposeFunction: jest.Mock<Promise<void>, []>
    }
    // Loaded by path: only the adapter may import the library by name
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its helper
    const { exposeFunctionIfAbsent } = require(join(libraryRoot, 'util/Puppeteer.js')) as {
      exposeFunctionIfAbsent: Helper
    }

    const pageWhere = (exposeFunction: FakePage['exposeFunction']): FakePage => ({
      evaluate: jest.fn<Promise<boolean>, []>().mockResolvedValue(false),
      exposeFunction
    })

    it('retries when a short-lived frame closes in the middle of the call', async () => {
      const exposeFunction = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error('Protocol error (Runtime.addBinding): Target closed'))
        .mockResolvedValueOnce(undefined)
      const page = pageWhere(exposeFunction)

      await exposeFunctionIfAbsent(page, 'onReady', () => undefined)

      expect(exposeFunction).toHaveBeenCalledTimes(2)
    })

    it('stops at once when the binding turned out to be there after the failed call', async () => {
      const exposeFunction = jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(new Error('Protocol error (Runtime.addBinding): Target closed'))
      const page = pageWhere(exposeFunction)
      page.evaluate.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

      await exposeFunctionIfAbsent(page, 'onReady', () => undefined)

      expect(exposeFunction).toHaveBeenCalledTimes(1)
    })

    it('does not expose anything when the binding is already there', async () => {
      const exposeFunction = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
      const page = pageWhere(exposeFunction)
      page.evaluate.mockResolvedValue(true)

      await exposeFunctionIfAbsent(page, 'onReady', () => undefined)

      expect(exposeFunction).not.toHaveBeenCalled()
    })

    it('passes on a rejection that carries no message', async () => {
      const exposeFunction = jest.fn<Promise<void>, []>().mockRejectedValue(undefined)

      await expect(
        exposeFunctionIfAbsent(pageWhere(exposeFunction), 'a', () => undefined)
      ).rejects.toBeUndefined()
      expect(exposeFunction).toHaveBeenCalledTimes(1)
    })

    it('gives up after five attempts and passes any other error on at once', async () => {
      const closed = jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(new Error('Protocol error: Target closed'))
      await expect(exposeFunctionIfAbsent(pageWhere(closed), 'a', () => undefined)).rejects.toThrow(
        'Target closed'
      )
      expect(closed).toHaveBeenCalledTimes(5)

      const other = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('boom'))
      await expect(exposeFunctionIfAbsent(pageWhere(other), 'a', () => undefined)).rejects.toThrow(
        'boom'
      )
      expect(other).toHaveBeenCalledTimes(1)
    })
  })

  // F23: WhatsApp Web 2.3000.1054445547 moved `sendPinInChatMsg` and `setGroupDescription` from
  // positional arguments to one object. The fakes below throw the TypeError of the real page when
  // they get the old shape, so a refresh that drops the patch fails here
  describe('the functions of WhatsApp Web that take one object (F23)', () => {
    const client = { client: { pupPage: { evaluate: evaluateHere } } }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const Message = require(join(libraryRoot, 'structures/Message.js')) as {
      prototype: { pin: (d: number) => Promise<boolean>; unpin: () => Promise<boolean> }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const GroupChat = require(join(libraryRoot, 'structures/GroupChat.js')) as {
      prototype: { setDescription: (d: string) => Promise<boolean> }
    }

    const options: Record<number, string> = {
      5: 'FiveSeconds',
      15: 'FifteenSeconds',
      60: 'OneMinute',
      86400: 'OneDay',
      604800: 'SevenDays',
      2592000: 'ThirtyDays',
      0: 'Never'
    }
    const pinModules = (
      sendPinInChatMsg: jest.Mock,
      constants: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
      WAWebCollections: { Msg: { get: () => ({ id: 'the-message' }) } },
      'WAWebProtobufsE2E.pb': {
        Message$PinInChatMessage$Type: { UNKNOWN_TYPE: 0, PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 }
      },
      WAWebPinMsgConstants: {
        getPinExpiryOption: (seconds: number) => {
          if (!(seconds in options)) throw new Error('Unexpeded pin expiry duration')
          return options[seconds]
        },
        getPinExpiryDuration: (option: string) => option,
        ...constants
      },
      WAWebSendPinMessageAction: { sendPinInChatMsg }
    })
    // What the real function does with the shape of before: it reads `msg` of the first argument
    const realPin = (response: unknown): jest.Mock =>
      jest.fn((arg: { msg?: { id: unknown } }) => {
        if (arg?.msg === undefined)
          throw new TypeError("Cannot read properties of undefined (reading 'id')")
        return Promise.resolve(response)
      })
    const pin = (modules: Record<string, unknown>, duration: number): Promise<boolean> =>
      withPage(modules, () =>
        Message.prototype.pin.call({ ...client, id: { _serialized: 'm1' } }, duration)
      )
    const unpin = (modules: Record<string, unknown>): Promise<boolean> =>
      withPage(modules, () =>
        Message.prototype.unpin.call({ ...client, id: { _serialized: 'm1' } })
      )

    it('pins with the object WhatsApp Web reads, the type and the option of the duration', async () => {
      const send = realPin({ messageSendResult: 'OK' })

      await expect(pin(pinModules(send), 86400)).resolves.toBe(true)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith({
        msg: { id: 'the-message' },
        pinType: 1,
        pinExpiryDurationOption: 'OneDay'
      })
    })

    it('unpins with the unpin type and no option', async () => {
      const send = realPin({ messageSendResult: 'OK' })

      await expect(unpin(pinModules(send))).resolves.toBe(true)

      expect(send).toHaveBeenCalledWith({
        msg: { id: 'the-message' },
        pinType: 2,
        pinExpiryDurationOption: undefined
      })
    })

    it('answers false, not a TypeError, when WhatsApp Web answers nothing or a refusal', async () => {
      await expect(pin(pinModules(realPin(null)), 86400)).resolves.toBe(false)
      await expect(pin(pinModules(realPin({ messageSendResult: 'ERROR' })), 86400)).resolves.toBe(
        false
      )
    })

    it('lets a duration WhatsApp Web does not know fail before anything is sent', async () => {
      const send = realPin({ messageSendResult: 'OK' })

      await expect(pin(pinModules(send), 7)).rejects.toThrow('Unexpeded pin expiry duration')

      expect(send).not.toHaveBeenCalled()
    })

    it('never replaces getPinExpiryDuration of WhatsApp Web, not even when the send fails', async () => {
      const getPinExpiryDuration = jest.fn((option: string) => option)
      const modules = pinModules(
        jest.fn(() => Promise.reject(new Error('send failed'))),
        { getPinExpiryDuration }
      )

      await expect(pin(modules, 86400)).rejects.toThrow('send failed')

      expect((modules.WAWebPinMsgConstants as Record<string, unknown>).getPinExpiryDuration).toBe(
        getPinExpiryDuration
      )
    })

    it('answers the page error with its cause when the module has another shape again', async () => {
      const modules = pinModules(realPin({ messageSendResult: 'OK' }))
      delete (modules.WAWebSendPinMessageAction as Record<string, unknown>).sendPinInChatMsg

      await expect(pin(modules, 86400)).rejects.toThrow(
        '[signature] WAWebSendPinMessageAction.sendPinInChatMsg is not available in WhatsApp Web'
      )
    })

    // The description: setGroupDescription reads groupWid of its object (`widToGroupJid(groupWid)`)
    const describeModules = (setGroupDescription: jest.Mock): Record<string, unknown> => ({
      WAWebWidFactory: { createWid: (id: string) => ({ wid: id }) },
      WAWebCollections: { Chat: { get: () => ({ groupMetadata: { descId: 'prev' } }) } },
      WAWebMsgKey: { newId: () => Promise.resolve('new') },
      WAWebGroupModifyInfoJob: { setGroupDescription }
    })
    const realDescribe = (): jest.Mock =>
      jest.fn((arg: { groupWid?: unknown }) => {
        if (arg?.groupWid === undefined)
          throw new TypeError("Cannot read properties of undefined (reading 'toJid')")
        return Promise.resolve()
      })
    const setDescription = (modules: Record<string, unknown>, text: string): Promise<boolean> =>
      withPage(modules, () =>
        GroupChat.prototype.setDescription.call(
          { ...client, id: { _serialized: 'g@g.us' }, groupMetadata: {} },
          text
        )
      )

    it('sets the description with the object WhatsApp Web reads', async () => {
      const set = realDescribe()

      await expect(setDescription(describeModules(set), 'hello')).resolves.toBe(true)

      expect(set).toHaveBeenCalledTimes(1)
      expect(set).toHaveBeenCalledWith({
        desc: 'hello',
        groupWid: { wid: 'g@g.us' },
        newDescId: 'new',
        prevDescId: 'prev'
      })
    })

    it('keeps the empty text as it was handed over, without turning it into null', async () => {
      const set = realDescribe()

      await setDescription(describeModules(set), '')

      expect(set).toHaveBeenCalledWith(expect.objectContaining({ desc: '' }))
    })

    it('answers false when the server refuses and passes any other error on', async () => {
      const refused = Object.assign(new Error('forbidden'), { name: 'ServerStatusCodeError' })

      await expect(
        setDescription(describeModules(jest.fn(() => Promise.reject(refused))), 'x')
      ).resolves.toBe(false)
      await expect(
        setDescription(describeModules(jest.fn(() => Promise.reject(new Error('boom')))), 'x')
      ).rejects.toThrow('boom')
    })

    it('answers the page error with its cause when the module has another shape again', async () => {
      const modules = describeModules(realDescribe())
      delete (modules.WAWebGroupModifyInfoJob as Record<string, unknown>).setGroupDescription

      await expect(setDescription(modules, 'x')).rejects.toThrow(
        '[signature] WAWebGroupModifyInfoJob.setGroupDescription is not available in WhatsApp Web'
      )
    })

    // The page throws for a duration it has no option for, which would be a 502: the body of the
    // pin endpoint only lets through durations WhatsApp Web knows (the others are a 400)
    it('only lets the pin body hand over durations that WhatsApp Web has an option for', () => {
      for (const seconds of PIN_DURATIONS) expect(options).toHaveProperty(String(seconds))
    })

    it('names the enum of the pin type when WhatsApp Web no longer has it', async () => {
      const modules = pinModules(realPin({ messageSendResult: 'OK' }))
      modules['WAWebProtobufsE2E.pb'] = {}

      await expect(pin(modules, 86400)).rejects.toThrow(
        '[signature] WAWebProtobufsE2E.pb Message$PinInChatMessage$Type is not available'
      )
    })

    it('answers [signature] when requiring the module throws', async () => {
      const modules = pinModules(realPin({ messageSendResult: 'OK' }))
      const original = modules.WAWebSendPinMessageAction
      Object.defineProperty(modules, 'WAWebSendPinMessageAction', {
        get: () => {
          throw new Error('boom from WhatsApp Web')
        }
      })
      expect(original).toBeDefined()

      await expect(pin(modules, 86400)).rejects.toThrow(
        '[signature] WAWebSendPinMessageAction.sendPinInChatMsg is not available'
      )
    })

    it('has no call with the positional shape left in the source', () => {
      expect(source('util/Injected/Utils.js')).not.toMatch(/sendPinInChatMsg\(message, action/)
      expect(source('structures/GroupChat.js')).not.toMatch(/setGroupDescription\(\s*chatWid/)
    })
  })

  // F25: WhatsApp Web 2.3000.1054456698 no longer exports four functions the library calls. Calling
  // `undefined(...)` inside the page after a first step had touched the network left a half done
  // operation; each of them now says which function is gone before anything is sent
  describe('the functions WhatsApp Web no longer exports (F25)', () => {
    const client = { client: { pupPage: { evaluate: evaluateHere } } }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const Client = require(join(libraryRoot, 'Client.js')) as {
      prototype: {
        setStatus: (s: string) => Promise<void>
        createGroup: (t: string, p: string[], o: object) => Promise<unknown>
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const Contact = require(join(libraryRoot, 'structures/Contact.js')) as {
      prototype: { getAbout: () => Promise<string | null> }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file of the library, read for its class
    const GroupChat = require(join(libraryRoot, 'structures/GroupChat.js')) as {
      prototype: {
        revokeInvite: () => Promise<string>
        addParticipants: (ids: string[], o?: object) => Promise<Record<string, unknown>>
      }
    }
    const wid = (id: string): { _serialized: string; server: string } => ({
      _serialized: id,
      server: id.split('@')[1] ?? ''
    })
    const widFactory = { createWid: (id: string) => wid(id) }

    it('setStatus names setMyStatus when the bridge no longer has it, and calls it when it does', async () => {
      const bridge: Record<string, unknown> = { queryStatusAll: jest.fn() }
      await expect(
        withPage({ WAWebContactStatusBridge: bridge }, () =>
          Client.prototype.setStatus.call({ pupPage: { evaluate: evaluateHere } }, 'hi')
        )
      ).rejects.toThrow(
        '[signature] WAWebContactStatusBridge.setMyStatus is not available in WhatsApp Web'
      )

      const setMyStatus = jest.fn(() => Promise.resolve())
      bridge.setMyStatus = setMyStatus
      await withPage({ WAWebContactStatusBridge: bridge }, () =>
        Client.prototype.setStatus.call({ pupPage: { evaluate: evaluateHere } }, 'hi')
      )
      expect(setMyStatus).toHaveBeenCalledWith('hi')
    })

    it('getAbout names getStatus when the bridge no longer has it', async () => {
      await expect(
        withPage({ WAWebWidFactory: widFactory, WAWebContactStatusBridge: {} }, () =>
          Contact.prototype.getAbout.call({ ...client, id: { _serialized: 'c@c.us' } })
        )
      ).rejects.toThrow(
        '[signature] WAWebContactStatusBridge.getStatus is not available in WhatsApp Web'
      )
    })

    it('revokeInvite names resetGroupInviteCode when the job no longer has it', async () => {
      await expect(
        withPage({ WAWebWidFactory: widFactory, WAWebGroupQueryJob: {} }, () =>
          GroupChat.prototype.revokeInvite.call({ ...client, id: { _serialized: 'g@g.us' } })
        )
      ).rejects.toThrow(
        '[signature] WAWebGroupQueryJob.resetGroupInviteCode is not available in WhatsApp Web'
      )
    })

    // A participant WhatsApp answers 403 to: the invite message is what is missing
    const created = (): Record<string, unknown> => ({
      title: 'g',
      subject: 'g',
      wid: wid('g@g.us'),
      participants: [
        { wid: wid('p@c.us'), error: 403, invite_code: 'code', invite_code_exp: '1', type: 'x' }
      ]
    })
    const gadd = jest.fn()
    const groupModules = (invite?: jest.Mock): Record<string, unknown> => ({
      WAWebWidFactory: widFactory,
      WAWebQueryExistsJob: { queryWidExists: () => Promise.resolve({ wid: true }) },
      WAWebGroupCreateJob: { createGroup: () => Promise.resolve(created()) },
      WAWebCollections: {
        Contact: { gadd },
        ProfilePicThumb: { find: () => Promise.resolve(undefined) },
        Chat: { get: () => ({ id: 'chat' }), find: () => Promise.resolve({ id: 'chat' }) }
      },
      WAWebApiContact: { getPhoneNumber: (w: unknown) => w },
      WAWebChatSendMessages: invite ? { sendGroupInviteMessage: invite } : {}
    })
    const createWith = (modules: Record<string, unknown>): Promise<unknown> =>
      withPage(modules, () =>
        Client.prototype.createGroup.call({ pupPage: { evaluate: evaluateHere } }, 'g', ['p'], {})
      )

    it('createGroup keeps the group and says the invite was not sent when its function is gone', async () => {
      const answer = (await createWith(groupModules())) as {
        participants: Record<string, { isInviteV4Sent: boolean; message: string }>
      }

      expect(gadd).not.toHaveBeenCalled()
      expect(answer.participants['p@c.us']).toMatchObject({ isInviteV4Sent: false })
      expect(answer.participants['p@c.us']?.message).toContain(
        '[signature] WAWebChatSendMessages.sendGroupInviteMessage is not available in WhatsApp Web'
      )
    })

    it('createGroup still sends the invite when the function is there', async () => {
      const invite = jest.fn(() => Promise.resolve({ messageSendResult: 'OK' }))

      const answer = (await createWith(groupModules(invite))) as {
        participants: Record<string, { isInviteV4Sent: boolean }>
      }

      expect(invite).toHaveBeenCalledTimes(1)
      expect(answer.participants['p@c.us']?.isInviteV4Sent).toBe(true)
    })

    // addParticipants: the page answers a 403 for the participant; the rest of the group is as it is
    const rpc403 = {
      name: 'AddParticipantsResponseSuccess',
      value: {
        addParticipant: [
          {
            addParticipantsParticipantAddedOrNonRegisteredWaUserParticipantErrorLidResponseMixinGroup:
              {
                value: {
                  addParticipantsParticipantMixins: {
                    name: 'ParticipantRequestCodeCanBeSent',
                    value: { error: '403', addRequestCode: 'c', addRequestExpiration: 1 }
                  }
                }
              }
          }
        ]
      }
    }
    const addModules = (invite?: jest.Mock): Record<string, unknown> => ({
      ...groupModules(invite),
      WAWebCollections: {
        Contact: { gadd },
        ProfilePicThumb: { find: () => Promise.resolve(undefined) },
        Chat: {
          get: () => ({
            id: 'chat',
            groupMetadata: { participants: { serialize: () => [] } },
            iAmAdmin: () => true,
            formattedTitle: 'g'
          }),
          find: () => Promise.resolve({ id: 'chat' })
        }
      },
      WAWebGroupQueryJob: { queryAndUpdateGroupMetadataById: () => Promise.resolve() },
      WAWebWidToJid: { widToGroupJid: (w: unknown) => w, widToUserJid: (w: unknown) => w },
      WASmaxGroupsAddParticipantsRPC: { sendAddParticipantsRPC: () => Promise.resolve(rpc403) },
      WAWebFindChatAction: { findOrCreateLatestChat: () => Promise.resolve({ chat: { id: 'c' } }) }
    })
    const add = (modules: Record<string, unknown>): Promise<Record<string, unknown>> =>
      withPage(modules, () =>
        GroupChat.prototype.addParticipants.call(
          { ...client, id: { _serialized: 'g@g.us' } },
          ['p@c.us'],
          { sleep: 0 }
        )
      )

    it('addParticipants answers the 403 with the reason when the invite function is gone', async () => {
      gadd.mockClear()
      const answer = (await add(addModules())) as Record<
        string,
        { code: number; isInviteV4Sent: boolean; message: string }
      >

      expect(gadd).not.toHaveBeenCalled()
      expect(answer['p@c.us']).toMatchObject({ code: 403, isInviteV4Sent: false })
      expect(answer['p@c.us']?.message).toContain(
        '[signature] WAWebChatSendMessages.sendGroupInviteMessage is not available in WhatsApp Web'
      )
    })

    it('addParticipants still sends the invite when the function is there', async () => {
      const invite = jest.fn(() => Promise.resolve({ messageSendResult: 'OK' }))

      const answer = (await add(addModules(invite))) as Record<string, { isInviteV4Sent: boolean }>

      expect(invite).toHaveBeenCalledTimes(1)
      expect(answer['p@c.us']?.isInviteV4Sent).toBe(true)
    })

    it('addParticipants does not look for the invite function when the caller turned the invite off', async () => {
      const answer = (await withPage(addModules(), () =>
        GroupChat.prototype.addParticipants.call(
          { ...client, id: { _serialized: 'g@g.us' } },
          ['p@c.us'],
          { sleep: 0, autoSendInviteV4: false }
        )
      )) as Record<string, { message: string }>

      expect(answer['p@c.us']?.message).not.toContain('[signature]')
    })
  })
})
