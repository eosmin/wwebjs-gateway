import { ESLint } from 'eslint'

// The architecture boundaries are ESLint rules, and a rule that stops matching fails silently. These
// tests read the effective rule of a file, so they need no source file to violate it.
interface Restriction {
  paths: { name: string }[]
  patterns: { group: string[] }[]
}

// Loading the whole config (typescript-eslint, import-x, every plugin) is the slow part, and it is
// paid once: a slow or busy machine must not make the first test of the file time out
const eslint = new ESLint()
const CONFIG_LOAD_TIMEOUT_MS = 60_000

beforeAll(async () => {
  await eslint.calculateConfigForFile('src/main.ts')
}, CONFIG_LOAD_TIMEOUT_MS)

async function restrictionsFor(file: string): Promise<Restriction> {
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules: Record<string, [unknown, Restriction]>
  }
  return config.rules['no-restricted-imports']?.[1] as Restriction
}

const names = (restriction: Restriction): string[] => restriction.paths.map(path => path.name)
const groups = (restriction: Restriction): string[] =>
  restriction.patterns.flatMap(pattern => pattern.group)

describe('architecture boundaries', () => {
  it('keeps whatsapp-web.js out of everything but the adapter', async () => {
    expect(names(await restrictionsFor('src/api/x.ts'))).toContain('whatsapp-web.js')
    expect(names(await restrictionsFor('src/whatsapp/wwebjs-adapter.ts'))).not.toContain(
      'whatsapp-web.js'
    )
  })

  it('keeps the Prisma client out of everything but src/database, by package and by path', async () => {
    const outside = await restrictionsFor('src/api/x.ts')
    const inside = await restrictionsFor('src/database/x.ts')

    expect(names(outside)).toContain('@prisma/client')
    expect(groups(outside)).toContain('**/generated/prisma/**')
    expect(names(inside)).not.toContain('@prisma/client')
    expect(groups(inside)).not.toContain('**/generated/prisma/**')
  })

  it('keeps Express, prom-client and redis banned everywhere', async () => {
    expect(names(await restrictionsFor('src/api/x.ts'))).toEqual(
      expect.arrayContaining(['@nestjs/platform-express', 'prom-client', 'redis'])
    )
  })

  it('keeps deep relative imports banned, including where an exception applies', async () => {
    for (const file of ['src/api/x.ts', 'src/database/x.ts', 'src/whatsapp/wwebjs-adapter.ts']) {
      expect(groups(await restrictionsFor(file))).toContain('../../../*')
    }
  })
})
