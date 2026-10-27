## Summary

<!-- What changes and why -->

## TDD reference

<!-- Which TDD section does this implement? e.g. §6.4 -->

## Checklist

- [ ] The title is a Conventional Commit, lowercase, 72 characters or fewer (it becomes the squash commit)
- [ ] Only `wwebjs-adapter.ts` imports whatsapp-web.js; only `src/database/**` uses Prisma
- [ ] New/changed capability is ONE `@WaOperation` with summary, description, examples, errors, `scope` and `wwebjs` links
- [ ] New env vars are in `env.schema.ts`, `.env.example` AND the docs
- [ ] Parity matrix / generated docs regenerated (`pnpm docs:gen`) and committed
- [ ] Tests added or updated (unit; integration if it touches Postgres/Redis); coverage gates pass
- [ ] Migration includes a rollback script in `prisma/rollbacks/`
- [ ] Sends stay idempotent; events keep `seq` order; nothing blocks the event pipeline
- [ ] No secrets, QR codes or WhatsApp session data in code, logs or fixtures
- [ ] The step's checkbox and progress row in `docs/IMPLEMENTATION_PLAN.md` are updated

## Migration notes

<!-- Deployment steps, breaking changes, or "none" -->
