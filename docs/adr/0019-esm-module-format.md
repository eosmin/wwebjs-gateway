# ADR 0019: the code is ESM

Status: Accepted (2026-10-27)

## Context

The module format had to be chosen at step 0.3, before any code existed. `@nestjs/core`,
`@nestjs/common` and `@nestjs/platform-fastify` 12 are ESM-only, and `nest new` defaults to ESM.

## Decision

The package is `"type": "module"`, TypeScript uses `module` and `moduleResolution` `nodenext`, and relative
imports carry the `.js` suffix. Jest's configs are `.cts` files, the specs compile to CommonJS
(`tsconfig.spec.json`), and Node runs Jest with `--experimental-vm-modules`, set once for every pnpm script
through `nodeOptions` in `pnpm-workspace.yaml`, with `moduleNameMapper` stripping the `.js` suffix of
relative imports.

## Consequences

- No top-level-await limitation and no dependence on `require(esm)`, which TypeScript 7 removes.
- The test tooling carries a flag and a mapping that a CommonJS project would not need.
- Every relative import is written with `.js`, which the compiler enforces under `nodenext`.

## Alternatives considered

- **CommonJS output:** only type-checks under `moduleResolution: node10`, and runs through Node 24's
  `require(esm)`, which breaks on top-level await and is removed from TypeScript 7.
- **Dual packages:** a build step with no consumer that needs it, since the project is a service and not a
  library.
