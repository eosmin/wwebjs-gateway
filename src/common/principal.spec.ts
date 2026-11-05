import { ForbiddenError } from './errors.js'
import {
  adminPrincipal,
  assertScope,
  assertSessionAccess,
  assertWebhookAccess,
  keyPrincipal
} from './principal.js'

function thrown(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('assertScope', () => {
  it('lets an admin through every scope, admin included', () => {
    for (const scope of ['read', 'send', 'manage', 'webhooks', 'events', 'admin'] as const) {
      expect(() => {
        assertScope(adminPrincipal(null), scope)
      }).not.toThrow()
    }
  })

  it('answers INSUFFICIENT_SCOPE for a scope the key does not hold', () => {
    const principal = keyPrincipal('k', 's1', ['send'])

    expect(thrown(() => assertScope(principal, 'webhooks'))).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      status: 403
    })
  })

  it('never grants admin to a key, even when the row says so', () => {
    const principal = keyPrincipal('k', 's1', ['read', 'admin', 'bogus'])

    expect([...principal.scopes]).toEqual(['read'])
    expect(() => {
      assertScope(principal, 'admin')
    }).toThrow(ForbiddenError)
  })
})

describe('assertSessionAccess', () => {
  it('lets a session key reach its own session only', () => {
    const principal = keyPrincipal('k', 's1', ['read'])

    expect(() => {
      assertSessionAccess(principal, 's1')
    }).not.toThrow()
    expect(thrown(() => assertSessionAccess(principal, 's2'))).toMatchObject({
      code: 'FORBIDDEN',
      status: 403
    })
  })

  it('lets an admin reach any session', () => {
    expect(() => {
      assertSessionAccess(adminPrincipal('k'), 'anything')
    }).not.toThrow()
  })
})

describe('assertWebhookAccess', () => {
  it('lets a session key reach the webhooks of its own session only', () => {
    const principal = keyPrincipal('k', 's1', ['webhooks'])

    expect(() => {
      assertWebhookAccess(principal, 's1')
    }).not.toThrow()
    expect(thrown(() => assertWebhookAccess(principal, 's2'))).toMatchObject({
      code: 'FORBIDDEN',
      status: 403
    })
  })

  it('keeps the webhooks of every session (no session) from a session key', () => {
    expect(
      thrown(() => assertWebhookAccess(keyPrincipal('k', 's1', ['webhooks']), null))
    ).toMatchObject({
      code: 'FORBIDDEN',
      status: 403
    })
  })

  it('lets an admin reach any webhook, the ones of every session included', () => {
    expect(() => {
      assertWebhookAccess(adminPrincipal('k'), null)
      assertWebhookAccess(adminPrincipal('k'), 's2')
    }).not.toThrow()
  })
})
