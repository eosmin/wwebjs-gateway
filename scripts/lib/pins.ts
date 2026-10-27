// The groups of package.json that pnpm installs. peerDependencies is left out on purpose: a peer
// range is how a library says which versions it supports, and this project is not a library.
const INSTALLED_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

// MAJOR.MINOR.PATCH, with an optional pre-release and build metadata: nothing a resolver could
// move
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

// A package.json has many more fields than these; the rest are not looked at
type Manifest = Partial<Record<(typeof INSTALLED_GROUPS)[number], Record<string, string>>> &
  Record<string, unknown>

// The dependencies that are not pinned to one exact version. The project pins every version on
// purpose (docs/adr/0002), so a range that slips in is a defect.
export function findUnpinnedDependencies(manifest: Manifest): string[] {
  return INSTALLED_GROUPS.flatMap(group =>
    Object.entries(manifest[group] ?? {})
      .filter(([, range]) => !EXACT_VERSION.test(range))
      .map(([name, range]) => `${group}.${name} is "${range}", which is not an exact version`)
  )
}
