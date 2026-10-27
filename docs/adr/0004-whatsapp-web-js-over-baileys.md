# ADR 0004: `whatsapp-web.js` over Baileys

Status: Accepted (2026-10-27)

## Context

The gateway is meant to expose the whole public API of a WhatsApp library over REST, Socket.IO and
webhooks, and to prove it with an automated parity test. Two unofficial libraries are the
realistic candidates:

- **`whatsapp-web.js`** drives WhatsApp Web itself: it starts a Chromium with Puppeteer and calls
  into the page. Its public surface (`Client`, `Chat`, `GroupChat`, `Channel`, `Message`, `Contact`,
  `Label`, `Broadcast`, `Poll`, `Call`) is what the project wants to mirror.
- **Baileys** is a TypeScript library that speaks the WhatsApp Web protocol directly over a
  WebSocket, without a browser.

Both are unofficial. Automating an account with either can violate WhatsApp's Terms of Service and
get a number banned; neither changes that risk, and the project's intended use (consent-based
conversations and chatbots, no mass messaging) is the same with both. The official WhatsApp
Business Cloud API is a non-goal.

## Decision

Wrap `whatsapp-web.js`, pinned to an exact version (1.34.7 at the start). Only
`src/whatsapp/wwebjs-adapter.ts` may import it; everything else depends on the
`WhatsAppClientPort` and the gateway's own DTOs. The parity test reads the library's type
declarations and fails when a symbol is neither mapped to an operation nor listed as unsupported
with a reason.

## Consequences

- Every running session is a Chromium of roughly 200 to 500 MB (the figure of TDD §2.5, to be
  replaced by a measurement in the operations guide). The gateway enforces `MAX_SESSIONS`,
  and the host is sized from it.
- A session's browser belongs to one Node process, so the gateway is single-instance by design, and
  failover is a fast restart with the session restored from `LocalAuth` on a persistent volume.
- WhatsApp Web changes can break the library. The WhatsApp Web version is pinned and exposed
  through the environment, and there is an upgrade and rollback runbook.
- The message's raw data (`rawData`) is the only place where ad and origin metadata lives, so the
  gateway sanitizes it and forwards it.
- The library has hard limits, which the documentation states instead of hiding: no event for an
  incoming typing or presence change, and timestamps of one-second resolution.
- Puppeteer rejections surface asynchronously, so every call goes through the adapter's timeout and
  error translation, and a stray rejection must never crash the process.
- Raw access to the page (`pupPage`, `pupBrowser`) and arbitrary `evaluate` are unsupported on
  purpose: they would be remote code execution.

## Alternatives considered

- **Baileys.** It would remove the browser, and with it most of the per-session memory. It was not
  chosen because it is a different surface: the project's goal is parity with the public API of
  `whatsapp-web.js`, and mapping Baileys instead is a different project. A move later would go
  behind the same `WhatsAppClientPort`, which is why that boundary exists.
- **The WhatsApp Business Cloud API.** It is the sanctioned route, with its own limits, templates
  and costs. It is a non-goal here, which is about running normal conversations on the owner's own
  accounts.
- **Supporting both libraries at once.** Two adapters to keep at parity for one owner, with no
  consumer asking for the second.
