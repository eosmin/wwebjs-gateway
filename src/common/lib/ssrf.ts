import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

import { Logger } from '@nestjs/common'

import { ValidationError } from '../errors.js'

import { type Family, parseNetwork } from './cidr.js'
import { withTimeout } from './timeout.js'

export interface SsrfPolicy {
  // Hostnames and CIDRs of private targets that are allowed on purpose (WEBHOOK_PRIVATE_HOST_ALLOWLIST)
  privateHostAllowlist: readonly string[]
  // Lets private and loopback targets through (ALLOW_PRIVATE_WEBHOOK_TARGETS; dev and test only; the
  // configuration refuses it in production). The metadata and link-local addresses stay blocked.
  allowPrivate: boolean
  resolve?: (hostname: string) => Promise<readonly string[]>
}

// The cloud metadata services and the link-local range: no allowlist and no switch opens them. One
// list for the three guards below, so an address added here closes in all of them.
const METADATA_RANGES: readonly (readonly [string, number, Family])[] = [
  // Includes the metadata address 169.254.169.254 of AWS, GCP and Azure
  ['169.254.0.0', 16, 'ipv4'],
  // The metadata service of Alibaba Cloud, inside the shared range 100.64.0.0/10
  ['100.100.100.200', 32, 'ipv4'],
  ['fe80::', 10, 'ipv6'],
  // The IPv6 metadata address of AWS, inside the unique-local range fc00::/7
  ['fd00:ec2::254', 128, 'ipv6'],
  // The WireServer of Azure (it hands out the credentials of the VM extensions): a public address that
  // only answers from inside Azure, so no other rule would catch it
  ['168.63.129.16', 32, 'ipv4']
]

const BLOCKED_RANGES: readonly (readonly [string, number, Family])[] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  // Includes the cloud metadata address 169.254.169.254
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  // 6to4 relay anycast, deprecated
  ['192.88.99.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  // IPv4-compatible (::a.b.c.d), deprecated
  ['::', 96, 'ipv6'],
  // NAT64, 6to4 and Teredo embed an IPv4 address that could be private
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  // IPv4-translated (SIIT): embeds an IPv4 address that could be private
  ['::ffff:0:0:0', 96, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6']
]

// BlockList also matches an IPv4-mapped IPv6 address (::ffff:127.0.0.1) against the IPv4 rules
const blockedRanges = new BlockList()
for (const [network, prefix, family] of [...BLOCKED_RANGES, ...METADATA_RANGES]) {
  blockedRanges.addSubnet(network, prefix, family)
}

// Never reachable, not even through the allowlist: the cloud metadata service lives here
const neverAllowed = new BlockList()
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ...METADATA_RANGES,
  ['::', 96, 'ipv6'],
  // IPv6 forms that embed an IPv4 address (NAT64, 6to4, Teredo) could smuggle in the ranges above
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['::ffff:0:0:0', 96, 'ipv6']
] as const) {
  neverAllowed.addSubnet(network, prefix, family)
}

// What stays closed when the whole guard is switched off (ALLOW_PRIVATE_WEBHOOK_TARGETS, for
// development): the cloud metadata services, which hand out credentials, and the IPv6 forms that can
// embed their address. Loopback and private ranges are what the switch is for, so they are not here.
const neverReachable = new BlockList()
for (const [network, prefix, family] of [
  // 0.0.0.0 and :: reach the machine itself on Linux, so they are not "private" targets but loopback
  // by another name (::ffff:0.0.0.0 is matched by the IPv4 rule)
  ['0.0.0.0', 8, 'ipv4'],
  ['::', 128, 'ipv6'],
  ...METADATA_RANGES,
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['::ffff:0:0:0', 96, 'ipv6']
] as const) {
  neverReachable.addSubnet(network, prefix, family)
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return true
  return blockedRanges.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

interface Allowlist {
  hostnames: Set<string>
  cidrs: BlockList
}

// An entry is a valid hostname or a valid address/CIDR; `10.0.0.0/99` is neither
export function isValidAllowlistEntry(entry: string): boolean {
  if (entry.includes('%')) return false
  if (/^\d[\d.]*(\/|$)|:/.test(entry)) return parseNetwork(entry) !== null
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(entry)
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

function parseAllowlist(entries: readonly string[]): Allowlist {
  const hostnames = new Set<string>()
  const cidrs = new BlockList()
  for (const raw of entries) {
    const entry = raw.trim()
    // The entry is the operator's (a host of their network): it goes to the log, never to the caller
    if (!isValidAllowlistEntry(entry)) throw rejectAddress('an entry of the allowlist is invalid')
    const parsed = parseNetwork(entry)
    if (parsed === null) hostnames.add(normalizeHostname(entry))
    else if (parsed.prefix === undefined) cidrs.addAddress(parsed.network, parsed.family)
    else cidrs.addSubnet(parsed.network, parsed.prefix, parsed.family)
  }
  return { hostnames, cidrs }
}

function reject(reason: string): ValidationError {
  return new ValidationError('VALIDATION_ERROR', `The URL is not allowed: ${reason}`, { reason })
}

const logger = new Logger('Ssrf')
// One answer for every way an address can be refused. A key of a session sees it (when it creates a
// webhook, in the error of a delivery), so telling a name that does not resolve from one that
// resolves to a private address would let it map the internal DNS. The detail stays in the log, with
// neither the URL nor the host.
const NOT_PUBLIC = 'the host does not resolve to a public address'

function rejectAddress(detail: string): ValidationError {
  logger.log(`A webhook URL was refused: ${detail}`)
  return reject(NOT_PUBLIC)
}

const DNS_TIMEOUT_MS = 5000

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true })
  return results.map(result => result.address)
}

async function resolveOrReject(
  hostname: string,
  resolve: (hostname: string) => Promise<readonly string[]>
): Promise<readonly string[]> {
  try {
    return await withTimeout(resolve(hostname), DNS_TIMEOUT_MS, 'dns lookup')
  } catch {
    throw rejectAddress('the host does not resolve')
  }
}

export interface PublicUrl {
  url: URL
  // What the host resolved to when it was checked. The sender should connect to one of these, so the
  // name cannot resolve somewhere else between the check and the connection (DNS rebinding).
  addresses: readonly string[]
}

// Accepts only http(s) URLs whose host resolves exclusively to public addresses (or to an allowlisted
// private one, or any but the metadata ones when `allowPrivate` is on). Call it again before every request: a name can resolve somewhere else later.
export async function assertPublicHttpUrl(rawUrl: string, policy: SsrfPolicy): Promise<PublicUrl> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw reject('it is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw reject('only http and https are supported')
  }
  if (url.username !== '' || url.password !== '') throw reject('it must not carry credentials')
  const hostname = normalizeHostname(url.hostname.replace(/^\[|\]$/g, ''))
  const allowlist = parseAllowlist(policy.privateHostAllowlist)
  const hostAllowed = allowlist.hostnames.has(hostname)
  const addresses =
    isIP(hostname) !== 0
      ? [hostname]
      : await resolveOrReject(hostname, policy.resolve ?? resolveAddresses)
  if (addresses.length === 0) throw rejectAddress('the host does not resolve')

  for (const address of addresses) {
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6'
    // Not even the switch for development opens these
    if (policy.allowPrivate && neverReachable.check(address, family)) {
      throw rejectAddress('the host resolves to a metadata, link-local or unspecified address')
    }
    if (policy.allowPrivate || !isBlockedAddress(address)) continue
    const allowed = hostAllowed || allowlist.cidrs.check(address, family)
    if (allowed && !neverAllowed.check(address, family)) continue
    throw rejectAddress('the host resolves to a private or reserved address')
  }
  return { url, addresses }
}
