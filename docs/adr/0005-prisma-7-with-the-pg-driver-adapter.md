# ADR 0005: Prisma 7 with the `pg` driver adapter and the `cjs` generator format

Status: Accepted (2026-10-27)

## Context

The gateway keeps sessions, API keys, webhooks, deliveries and stored messages in PostgreSQL. Prisma
7 changed how the client is built: the `prisma-client` generator writes plain TypeScript into the
repository (there is no client inside `node_modules` any more), and every client needs a driver
adapter. The connection URL for the CLI lives in `prisma.config.ts`, not in the schema.

The package is ESM (`"type": "module"`, `nodenext`), and `nest build` compiles it with `tsc`. The
Jest suites are compiled to CommonJS (`tsconfig.spec.json`). The default ESM output of the
generator reads `import.meta.url`, which Jest cannot load, and Prisma 8 is still a release
candidate.

## Decision

- Prisma and `@prisma/client` 7.10.1 with `@prisma/adapter-pg` 7.10.1 and `pg` 8.23.1 (the version the adapter resolves, so there is one copy). `prisma`
  is a runtime dependency, because the image runs `prisma migrate deploy` before starting Node.
- The generator uses `moduleFormat = "cjs"` and `importFileExtension = "js"`. That output has no
  `import.meta` (the files still use `import`/`export`, and `tsc` compiles them as ESM with the rest
  of the package), so Jest and the compiled build load the same generated client, and the
  `.js` suffix is what `nodenext` needs to resolve its imports (the Jest `moduleNameMapper` strips
  it). This was checked by running the compiled build against Postgres, not only the specs.
- `PrismaService` extends the generated client, builds the `PrismaPg` adapter from `DATABASE_URL`
  in its constructor, connects in `onModuleInit` and disconnects in `onApplicationShutdown`. The first
  connection is retried with backoff and proven with a real query, because a driver adapter may
  not open a socket on `$connect()`. Each attempt is bounded by `connectionTimeoutMillis` (5 s): the
  pool waits forever by default, and an address that never answers would hang the boot inside one
  attempt. A wrong password or a missing database (`meta.driverAdapterError.cause.kind`) is not
  retried, and when the boot fails the pool is released. The log carries the last line of the
  failure (or its error code, when a refused connection gives no reason) with the credentials of any
  connection string removed, never the connection string.
- Only `src/database/**` may import the generated client; the rest of the code uses repositories.
- `DatabaseModule` is imported into `AppModule` together with its first consumer (the
  repositories), so the application and its specs do not need Postgres before something uses it.

## Consequences

- The generated client is git-ignored: a clean checkout runs `pnpm db:generate` before type-checking
  or testing. CI and `pnpm bootstrap` already do.
- A Prisma upgrade that changes the generator options has to be checked in both worlds (Jest and
  the compiled build). The Jest suites cover the first; the second is covered by the CI boot check
  only once `DatabaseModule` is imported into `AppModule`, so until then it is a manual check.
- A Postgres that is down for longer than the retry window (eight attempts of at most 5 s each plus
  about 18 s of backoff, so about a minute) fails the boot, which is the intended behavior for a
  single instance that cannot work without its database.
- The pool is closed in `onApplicationShutdown`, not in `onModuleDestroy` as the first draft of the
  TDD said: it runs after the queue workers (step 5) have closed, so none of them writes to a closed
  client. It is bounded to 5 s with `withTimeout`, as `RedisService` bounds its `quit()`; a pool that
  does not close is logged and the shutdown goes on.

## Alternatives considered

- **The default ESM output of the generator.** Rejected: Jest fails on `import.meta`.
- **Running Jest as native ESM.** Not tried: it needs the experimental `--experimental-vm-modules`
  flag for all the suites, for the sake of one generated folder.
- **`importFileExtension` left empty.** Rejected: `tsc` with `nodenext` cannot resolve extensionless
  relative imports, so the client lost its types.
- **`prisma@8` release candidate.** Rejected: not a stable release.
- **Another driver or an ORM other than Prisma.** Rejected: the schema, migrations and typed client
  are what the project wants, and the toolchain mirrors `omnichannel-platform`.
