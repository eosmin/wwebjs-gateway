import { BlockList, isIP } from 'node:net'

export type Family = 'ipv4' | 'ipv6'

const MAX_PREFIX = { ipv4: 32, ipv6: 128 } as const

// Splits an address or an address/prefix into its parts, or null when it is neither
export function parseNetwork(
  entry: string
): { network: string; family: Family; prefix?: number } | null {
  const [network = '', prefixText, ...extra] = entry.split('/')
  const family = isIP(network) === 4 ? 'ipv4' : isIP(network) === 6 ? 'ipv6' : null
  if (family === null) return null
  if (prefixText === undefined && extra.length === 0) return { network, family }
  const prefix = /^\d{1,3}$/.test(prefixText ?? '') ? Number(prefixText) : NaN
  if (extra.length > 0 || !(prefix <= MAX_PREFIX[family])) return null
  return { network, family, prefix }
}

export function isValidCidr(entry: string): boolean {
  return !entry.includes('%') && parseNetwork(entry) !== null
}

// An entry that is not a valid address or CIDR matches nothing, so a corrupt list only ever denies
export function buildCidrList(entries: readonly string[]): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const parsed = isValidCidr(entry) ? parseNetwork(entry) : null
    if (parsed === null) continue
    if (parsed.prefix === undefined) list.addAddress(parsed.network, parsed.family)
    else list.addSubnet(parsed.network, parsed.prefix, parsed.family)
  }
  return list
}

// BlockList matches an IPv4-mapped IPv6 address (::ffff:10.0.0.1) against the IPv4 entries. An
// address that does not parse is never inside the list.
export function ipInList(list: BlockList, address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6')
}
