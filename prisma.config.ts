import { existsSync } from 'node:fs'

import { defineConfig } from 'prisma/config'

// The Prisma CLI does not read .env files. .env.local is the file `pnpm bootstrap` creates for
// development; CI and the container get their variables from the environment instead.
if (existsSync('.env.local')) process.loadEnvFile('.env.local')

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] }
})
