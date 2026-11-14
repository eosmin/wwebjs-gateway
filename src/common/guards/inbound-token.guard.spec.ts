import type { ExecutionContext } from '@nestjs/common'

import type { InboundHookService } from '../../services/inbound-hook.service.js'
import { ServiceBusyError, UnauthorizedError } from '../errors.js'

import { type InboundRequest, InboundTokenGuard } from './inbound-token.guard.js'

const TOKEN = 'A'.repeat(43)

function setup(params: unknown = { token: TOKEN }) {
  const hooks = {
    resolve: jest.fn(() => Promise.resolve({ hookId: 'hook-1', sessionId: 'main' })),
    admitSend: jest.fn()
  }
  const request = { params } as unknown as InboundRequest
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext
  const guard = new InboundTokenGuard(hooks as unknown as InboundHookService)
  return { guard, hooks, request, context }
}

describe('InboundTokenGuard', () => {
  it('resolves the token, counts the request against the hook and hands the grant on', async () => {
    const { guard, hooks, request, context } = setup()

    await expect(guard.canActivate(context)).resolves.toBe(true)

    expect(hooks.resolve).toHaveBeenCalledWith(TOKEN)
    expect(hooks.admitSend).toHaveBeenCalledWith('hook-1')
    expect(request.inboundGrant).toEqual({ hookId: 'hook-1', sessionId: 'main' })
  })

  it('refuses a token the service refuses, and counts nothing', async () => {
    const { guard, hooks, request, context } = setup()
    hooks.resolve.mockRejectedValue(new UnauthorizedError('UNAUTHORIZED'))

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError)

    expect(hooks.admitSend).not.toHaveBeenCalled()
    expect(request.inboundGrant).toBeUndefined()
  })

  it('refuses a hook over its allowance and grants nothing', async () => {
    const { guard, hooks, request, context } = setup()
    hooks.admitSend.mockImplementation(() => {
      throw new ServiceBusyError('RATE_LIMITED', 12, true)
    })

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 12
    })
    expect(request.inboundGrant).toBeUndefined()
  })

  it.each([[null], [{}], [{ token: 42 }]])(
    'is a 401 when the route has no token (%j)',
    async params => {
      const { guard, hooks, context } = setup(params)

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError)
      expect(hooks.resolve).not.toHaveBeenCalled()
    }
  )
})
