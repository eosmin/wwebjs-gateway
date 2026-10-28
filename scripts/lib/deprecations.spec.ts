import { DEPRECATED_APIS, findDeprecations, isScanned } from './deprecations.js'

// One source line that must be reported and one that must not, for every entry of the list
const CASES: Record<string, { hit: string; miss: string }> = {
  'prisma.$use(': { hit: 'prisma.$use(middleware)', miss: 'prisma.$extends(extension)' },
  'prisma-client-js': {
    hit: 'generator client { provider = "prisma-client-js" }',
    miss: 'generator client { provider = "prisma-client" }'
  },
  'datasourceUrl / datasources': {
    hit: 'new PrismaClient({ datasourceUrl: url })',
    miss: 'new PrismaClient({ adapter })'
  },
  'prisma db push': { hit: 'run prisma db push now', miss: 'run prisma migrate deploy now' },
  'z.nativeEnum(': { hit: 'z.nativeEnum(Status)', miss: 'z.enum(Status)' },
  'z.string().url() / .email() / .uuid()': {
    hit: 'z.string().trim().email()',
    miss: 'z.email()'
  },
  'z.coerce.boolean(': { hit: 'z.coerce.boolean()', miss: 'z.stringbool()' },
  'z.object(...).strict() / .passthrough()': {
    hit: 'z.object({ a: z.string() }).strict()',
    miss: 'z.strictObject({ a: z.string() })'
  },
  "from 'zod/v3'": { hit: "import { z } from 'zod/v3'", miss: "import { z } from 'zod'" },
  "from 'redis'": {
    hit: "import { createClient } from 'redis'",
    miss: "import Redis from 'ioredis'"
  },
  'prom-client': { hit: "import client from 'prom-client'", miss: 'collectDefaultMetrics()' },
  QueueScheduler: { hit: 'new QueueScheduler(name)', miss: 'queue.upsertJobScheduler(id)' },
  '@nestjs/platform-express': {
    hit: "import x from '@nestjs/platform-express'",
    miss: "import x from '@nestjs/platform-fastify'"
  },
  'new Buttons( / new List(': { hit: 'new Buttons(body, [])', miss: 'new Poll(name, options)' },
  "'incoming_call' / 'code_received' events": {
    hit: "client.on('incoming_call', fn)",
    miss: "client.on('call', fn)"
  },
  'patchNestJsSwagger(': {
    hit: 'patchNestJsSwagger()',
    miss: 'cleanupOpenApiDoc(document)'
  }
}

describe('findDeprecations', () => {
  it('has a case for every entry of the list', () => {
    expect(Object.keys(CASES).sort()).toEqual(DEPRECATED_APIS.map(api => api.name).sort())
  })

  it.each(Object.entries(CASES))('reports %s and only it', (name, { hit, miss }) => {
    expect(findDeprecations('src/a.ts', hit).map(finding => finding.api)).toContain(name)
    expect(findDeprecations('src/a.ts', miss).map(finding => finding.api)).not.toContain(name)
  })

  it('ignores a banned API that only a comment names', () => {
    const source = ['// z.nativeEnum( was removed', '/* prom-client', 'QueueScheduler */'].join(
      '\n'
    )

    expect(findDeprecations('src/a.ts', source)).toEqual([])
  })

  it('keeps a "//" inside a string as text, not as a comment', () => {
    expect(findDeprecations('src/a.ts', "const url = 'http://x'; z.nativeEnum(A)")).toHaveLength(1)
  })

  it('sees a call that Prettier broke over several lines, on the right line', () => {
    const source = ['const a = 1', 'const s = z.string()', '  .trim()', '  .email()'].join('\n')

    expect(findDeprecations('src/a.ts', source)).toEqual([
      {
        file: 'src/a.ts',
        line: 2,
        api: 'z.string().url() / .email() / .uuid()',
        replacement: 'z.url() / z.email() / z.uuid()'
      }
    ])
  })

  it('does not scan files that are not application code', () => {
    expect(findDeprecations('docs/TDD.md', 'z.nativeEnum(A)')).toEqual([])
    expect(findDeprecations('node_modules/x/index.js', 'z.nativeEnum(A)')).toEqual([])
    expect(findDeprecations('eslint.config.js', "{ name: 'prom-client' }")).toEqual([])
    expect(
      findDeprecations(
        'tests/parity/lint-boundaries.spec.ts',
        "expect(names).toContain('prom-client')"
      )
    ).toEqual([])
  })
})

describe('isScanned', () => {
  it.each([
    ['src/main.ts', true],
    ['prisma/schema.prisma', true],
    ['package.json', true],
    ['README.md', false],
    ['pnpm-lock.yaml', false],
    ['prisma/migrations/1_init/migration.sql', false],
    ['scripts/lib/deprecations.ts', false],
    ['scripts/lib/deprecations.spec.ts', false]
  ])('%s -> %s', (file, expected) => {
    expect(isScanned(file)).toBe(expected)
  })
})
