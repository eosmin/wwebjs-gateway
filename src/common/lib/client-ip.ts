// The address a request really came from. Each trusted proxy appends the address it saw to
// X-Forwarded-For, so counting `trustedHops` entries back from the socket skips what the caller
// wrote itself; with 0 hops the header is ignored and the socket peer is the client.
export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedHops: number
): string {
  const peer = socketAddress ?? ''
  if (trustedHops <= 0 || forwardedFor === undefined) return peer
  const forwarded = forwardedFor
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
  // Fewer entries than proxies: the request skipped a proxy, so the header is the caller's own
  if (forwarded.length < trustedHops) return peer
  const chain = [...forwarded, peer]
  return chain[chain.length - 1 - trustedHops] ?? peer
}
