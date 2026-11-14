export interface CurlRequest {
  method: string
  path: string
}

// The requests that the `curl` examples of a guide make to the gateway: method and path, with the
// query and the host dropped. A shell variable or a placeholder in the path stands for one segment.
export function curlRequests(text: string): CurlRequest[] {
  const joined = text.replace(/\\\r?\n/g, ' ')
  const requests: CurlRequest[] = []

  for (const line of joined.split('\n')) {
    const start = line.indexOf('curl ')
    if (start === -1) continue
    const command = line.slice(start)
    const url =
      /(?:https?:\/\/[^/\s"']+)?(\/[A-Za-z0-9_\-./{}$<>:]*)(?:\?[^\s"']*)?["']?(?:\s|$)/.exec(
        command.replace(/^curl\s+/, ' ')
      )
    if (url?.[1] === undefined) continue
    const explicit = /(?:-X|--request)\s+([A-Z]+)/.exec(command)?.[1]
    const hasBody = /\s(-d|--data[\w-]*|-F|--form)\s/.test(command)
    requests.push({
      method: explicit ?? (hasBody ? 'POST' : 'GET'),
      path: url[1].replace(/\/$/, '') || '/'
    })
  }
  return requests
}

const segment = (part: string): string =>
  /^(\{[^}]+\}|:\w+|\$\{?\w+\}?|<[^>]+>)$/.test(part) ? '*' : part

// Whether a request lands on one of the routes of the document: `{id}` in the route and a variable
// or a placeholder in the example each stand for one segment
export function matchesRoute(request: CurlRequest, routes: readonly CurlRequest[]): boolean {
  const wanted = request.path.split('/').map(segment)

  return routes.some(route => {
    const parts = route.path.split('/')

    return (
      route.method === request.method &&
      parts.length === wanted.length &&
      parts.every((part, index) => {
        const mine = wanted[index]
        return mine === '*' || segment(part) === '*' || part === mine
      })
    )
  })
}
