# ADR 0010: one `@WaOperation` registry drives every surface

Status: Accepted (2026-10-27)

## Context

The gateway offers the same capabilities over REST, Socket.IO commands, an OpenAPI document and
generated reference pages, and it promises 100% parity with the library it wraps. Written by hand, each
surface drifts: a route without a socket command, a scope that differs between the guard and the docs, a
documented field that does not exist.

## Decision

A capability is **one controller method** decorated with `@WaOperation({ ... })`. The decorator carries
the id, the `scope` (`read`, `send`, `manage`, `webhooks`, `events` or `admin`), the summary, the examples,
the errors, the `wwebjs` symbols it covers and, when it has one, its `socket.command`.
`OperationRegistryService` reads those decorators at boot. From the registry come:

- the REST route and the check of the scope (`RequireScope` is applied by the decorator, so the scope is
  mandatory; a route with no declared scope is treated as `admin`, which closes it);
- the socket command and its dispatcher (a command runs the operation of the registry, so it needs that
  operation's scope), with the operations that stay on REST listed in `REST_ONLY_OPERATIONS` with a reason;
- the OpenAPI document, with `x-scope` on each operation;
- `operations-list.md`, `websocket-commands.md` and `parity-matrix.md`.

Nothing parallel is written by hand for something the registry covers. Tests make this binding: the
parity test fails when a `whatsapp-web.js` symbol is neither covered by an operation, an event or a field,
nor listed in `UNSUPPORTED_SYMBOLS` with a reason; the OpenAPI completeness test fails when an operation
has no `x-scope` or no success schema; and `pnpm validate:docs` fails when a generated file differs from a
fresh generation.

## Consequences

- Adding a capability is one method; the route, the command, the schema and the docs follow.
- A new `whatsapp-web.js` symbol breaks the build until someone decides what it is: exposed, or
  unsupported with a reason. The list of unsupported symbols is therefore a record of decisions.
- The generators need the real controllers, so `docs:gen` builds the registry inside a Nest testing module
  with stand-ins for the injections (no database, Redis or WhatsApp needed).
- Decorator metadata matters: the OpenAPI generation silently loses every body and parameter schema
  without `design:paramtypes`, which is why the docs scripts compile with `tsc` and not with `tsx`.

## Alternatives considered

- **Hand-written routes plus a parity checklist:** the checklist is the first thing to go stale.
- **Generate the controllers from the library's typings:** the typings are not the runtime (several
  fields are typed `string` and hold objects), and the gateway has its own DTOs, scopes and errors.
- **Describe the API only in OpenAPI and derive routes from it:** the scope, the socket command and the
  `wwebjs` links would need extensions of their own, and Nest validation and guards work from the
  controller anyway.
