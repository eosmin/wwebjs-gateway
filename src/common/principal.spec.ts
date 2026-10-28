import { ForbiddenError } from './errors.js'
import { adminPrincipal, assertScope, assertSessionAccess, keyPrincipal } from './principal.js'

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
