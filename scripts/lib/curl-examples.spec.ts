import { curlRequests, matchesRoute } from './curl-examples.js'

describe('curlRequests', () => {
  it('reads the method from -X, and POST from a body, and GET otherwise', () => {
    const text = [
      'curl -X DELETE http://localhost:3000/v1/sessions/s1',
      'curl -d \'{"a":1}\' http://localhost:3000/v1/sessions',
      'curl -H "Authorization: Bearer $KEY" "http://localhost:3000/v1/sessions?limit=2"'
    ].join('\n')

    expect(curlRequests(text)).toEqual([
      { method: 'DELETE', path: '/v1/sessions/s1' },
      { method: 'POST', path: '/v1/sessions' },
      { method: 'GET', path: '/v1/sessions' }
    ])
  })

  it('joins the lines of a command that continues with a backslash', () => {
    const text =
      'curl -X POST \\\n  -H "x: y" \\\n  http://localhost:3000/v1/api-keys \\\n  -d \'{}\'\n'

    expect(curlRequests(text)).toEqual([{ method: 'POST', path: '/v1/api-keys' }])
  })

  it('ignores prose that has no curl command', () => {
    expect(curlRequests('Use a client such as the one in /v1/docs.')).toEqual([])
  })
})

describe('matchesRoute', () => {
  const routes = [
    { method: 'GET', path: '/v1/sessions/{sessionId}/chats' },
    { method: 'POST', path: '/v1/sessions' },
    { method: 'GET', path: '/metrics' }
  ]

  it('matches a route by method and segments, a name or a variable standing for a parameter', () => {
    expect(matchesRoute({ method: 'GET', path: '/v1/sessions/s1/chats' }, routes)).toBe(true)
    expect(matchesRoute({ method: 'GET', path: '/v1/sessions/$ID/chats' }, routes)).toBe(true)
    expect(matchesRoute({ method: 'GET', path: '/metrics' }, routes)).toBe(true)
  })

  it.each([
    ['a method the route does not have', { method: 'DELETE', path: '/v1/sessions' }],
    ['a path that is not there', { method: 'GET', path: '/v1/sesions/s1/chats' }],
    ['a longer path', { method: 'GET', path: '/v1/sessions/s1/chats/x' }]
  ])('rejects %s', (_what, request) => {
    expect(matchesRoute(request, routes)).toBe(false)
  })
})
