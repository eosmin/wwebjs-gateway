export interface DeprecatedApi {
  name: string
  pattern: RegExp
  replacement: string
}

export const DEPRECATED_APIS: readonly DeprecatedApi[] = [
  { name: 'prisma.$use(', pattern: /\.\$use\(/, replacement: '$extends (Prisma 7)' },
  {
    name: 'prisma-client-js',
    pattern: /prisma-client-js/,
    replacement: 'the generator "prisma-client"'
  },
  {
    name: 'datasourceUrl / datasources',
    pattern: /\bdatasourceUrl\s*:|\bdatasources\s*:\s*\{/,
    replacement: 'a driver adapter (PrismaPg)'
  },
  {
    name: 'prisma db push',
    pattern: /prisma\s+db\s+push/,
    replacement: 'prisma migrate dev / deploy'
  },
  { name: 'z.nativeEnum(', pattern: /\bz\.nativeEnum\(/, replacement: 'z.enum(Enum)' },
  {
    name: 'z.string().url() / .email() / .uuid()',
    pattern:
      /\bz\.string\(\)(\s*\.\w+\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\s*\.(url|email|uuid)\(/,
    replacement: 'z.url() / z.email() / z.uuid()'
  },
  { name: 'z.coerce.boolean(', pattern: /\bz\.coerce\.boolean\(/, replacement: 'z.stringbool()' },
  {
    name: 'z.object(...).strict() / .passthrough()',
    pattern: /\}\)\s*\.(strict|passthrough)\(/,
    replacement: 'z.strictObject() / z.looseObject()'
  },
  {
    name: "from 'zod/v3'",
    pattern: /['"]zod\/v3['"]/,
    replacement: "import { z } from 'zod' (Zod 4)"
  },
  {
    name: "from 'redis'",
    pattern: /(\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)['"]redis(\/[^'"]*)?['"]/,
    replacement: 'ioredis'
  },
  { name: 'prom-client', pattern: /prom-client/, replacement: '@prometheus-io/client' },
  {
    name: 'QueueScheduler',
    pattern: /\bQueueScheduler\b/,
    replacement: 'queue.upsertJobScheduler (BullMQ)'
  },
  {
    name: '@nestjs/platform-express',
    pattern: /@nestjs\/platform-express/,
    replacement: '@nestjs/platform-fastify'
  },
  {
    name: 'new Buttons( / new List(',
    pattern: /\bnew\s+(Buttons|List)\(/,
    replacement: 'polls; Buttons/List are unsupported (parity matrix)'
  },
  {
    name: "'incoming_call' / 'code_received' events",
    pattern: /['"](incoming_call|code_received)['"]/,
    replacement: "the real wwebjs events 'call' / 'code'"
  },
  {
    name: 'patchNestJsSwagger(',
    pattern: /\bpatchNestJsSwagger\(/,
    replacement: 'cleanupOpenApiDoc(document) (nestjs-zod 5)'
  }
]

// Files that are not application code, or that are the list itself. The ESLint config names the
// banned packages on purpose, to forbid them, and so does the test that guards those bans: they
// are the list's twins.
const NOT_SCANNED =
  /(^|\/)(node_modules|dist|coverage|generated)\/|^(docs|prisma\/migrations|prisma\/rollbacks)\/|(^|\/)(pnpm-lock\.yaml|eslint\.config\.js|tests\/parity\/lint-boundaries\.spec\.ts|scripts\/lib\/deprecations(\.spec)?\.ts)$/
const SCANNED_EXTENSIONS = /\.(ts|tsx|js|jsx|cjs|mjs|cts|mts|prisma)$|(^|\/)package\.json$/

export interface Finding {
  file: string
  line: number
  api: string
  replacement: string
}

export function isScanned(file: string): boolean {
  return !NOT_SCANNED.test(file) && SCANNED_EXTENSIONS.test(file)
}

// The source without its comments. The lines stay where they were, so that a finding has the right
// line. The text of a string is kept (a "//" in it is not a comment). A quote ends at the end of its
// line; a template literal does not.
function withoutComments(source: string): string {
  let out = ''
  let quote: string | undefined
  let comment: 'line' | 'block' | undefined
  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i)
    const next = source.charAt(i + 1)
    if (char === '\n') {
      if (comment === 'line') comment = undefined
      if (quote !== undefined && quote !== '`') quote = undefined
      out += char
    } else if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = undefined
        i++
      }
    } else if (comment === 'line') {
      // dropped until the end of the line
    } else if (quote !== undefined) {
      out += char
      if (char === '\\') {
        out += next
        i++
      } else if (char === quote) {
        quote = undefined
      }
    } else if (char === '\\') {
      // An escaped slash, as in /^https?:\/\//, is not the start of a comment
      out += char + next
      i++
    } else if (char === '/' && next === '/') {
      comment = 'line'
    } else if (char === '/' && next === '*') {
      comment = 'block'
      i++
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char
      out += char
    }
  }
  return out
}

export function findDeprecations(file: string, source: string): Finding[] {
  if (!isScanned(file)) return []
  const findings: Finding[] = []
  // Over the whole text, so that a call that Prettier broke over several lines is still seen
  const code = withoutComments(source)
  for (const api of DEPRECATED_APIS) {
    for (const match of code.matchAll(new RegExp(api.pattern.source, 'g'))) {
      const line = code.slice(0, match.index).split('\n').length
      findings.push({ file, line, api: api.name, replacement: api.replacement })
    }
  }
  findings.sort((a, b) => a.line - b.line)
  return findings
}
