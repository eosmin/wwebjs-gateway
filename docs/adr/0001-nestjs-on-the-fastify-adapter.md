# ADR 0001: NestJS on the Fastify adapter

Status: Accepted (2026-10-27)

## Context

The gateway is one process that serves REST, Socket.IO and webhooks, runs queues and timers, talks
to PostgreSQL and Redis, and has to keep one WhatsApp session per account alive. It needs modules
and dependency injection to keep those parts apart, guards to authorize REST routes and socket
commands the same way, a validation layer that also feeds the OpenAPI document, and first-class
WebSocket, queue and scheduling support. The owner's other production project,
`omnichannel-platform`, already runs on NestJS 12, so the framework and its pitfalls are known.

NestJS does not bring its own HTTP server: it runs on an adapter. The default is Express.

## Decision

Use NestJS 12 with `@nestjs/platform-fastify`, which runs Fastify 5. Validate with Zod 4 through
`nestjs-zod`, so one schema produces the runtime check, the DTO class and the OpenAPI schema.
`@nestjs/platform-express` is never installed: the ESLint config and the deprecation scanner both
fail on it. The adapter pins `fastify` to an exact version, so `fastify` is a direct dependency at
that same version and never at another one.

## Consequences

- The route handlers, guards and interceptors are written once and serve REST and Socket.IO.
- NestJS 12 is published as ESM only, so the project is ESM (`"type": "module"`, `nodenext`,
  `.js` suffixes on relative imports). Jest runs the CommonJS compiled specs with
  `--experimental-vm-modules` so that it can load those packages; `pnpm-workspace.yaml` sets it
  once for every script.
- Fastify requires complete schemas, which `nestjs-zod` provides. Express-only APIs
  (`req.res`, Express middleware types) are off limits.
- The adapter decides the Fastify version. The first pin of this project, `fastify@5.12.1`, had four
  high advisories, and the fix arrived with `@nestjs/platform-fastify@12.0.2`: security bumps of
  the adapter move `fastify` with it.
- The Socket.IO adapter attaches to the HTTP server that Fastify owns, so one port serves both.

## Alternatives considered

- **NestJS on the Express adapter (the default).** It would have worked, and more middleware is
  written for Express. It was not chosen because the project wants schema-first validation, and
  Fastify's request pipeline is built around schemas.
- **Fastify alone, with hand-written structure.** Fewer dependencies, but the module system, the
  guards, the queue and WebSocket integrations and the OpenAPI wiring would all be rebuilt by hand,
  and the project would stop sharing its structure with `omnichannel-platform`.
- **Another framework (Hono, Elysia).** The WebSocket, queue and scheduling integrations that the
  gateway depends on are the ones NestJS ships; leaving it means giving those up.
