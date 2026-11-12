# Calls

The routes under `/v1/sessions/:sessionId/calls` (TDD §6.11). Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). The library cannot place or answer a call: it offers a link for a scheduled call and rejecting an incoming one. The incoming calls themselves arrive as the `call` event ([events](events.md)).

| Operation          | Route                     | Scope    | Answer                    |
| ------------------ | ------------------------- | -------- | ------------------------- |
| `calls.createLink` | `POST …/calls/link`       | `manage` | `200` with `{ link }`     |
| `calls.reject`     | `POST …/calls/:callId/reject` | `manage` | `204`, no body        |

- **`calls.createLink`** takes `{ startTime, callType }`: `startTime` is an ISO 8601 date and `callType` is `voice` or `video`. The answer is `{ link }`, such as `https://call.whatsapp.com/video/XxXx`. When WhatsApp Web cannot make a link the library answers an empty string, and the gateway turns that into `502 WHATSAPP_ERROR` instead of passing it on. **Known limit (F14b):** on WhatsApp Web 2.3000.1054320313 the module that makes the link is not loaded and no bundle is known that loads it, so every call answers `502 WHATSAPP_ERROR`; the gateway log says `[lazy-module] WAWebGenerateEventCallLink is not available in WhatsApp Web <build> (no bundle is known to load it)`. The same module makes the call link of an event (`callType` other than `none` in `messages.send`).
- **`calls.reject`** rejects the call whose id the `call` event gave (`:callId`). wwebjs can only reject through the call object it delivered, so the gateway keeps the most recent incoming calls in memory, a ring buffer of `CALL_CACHE_SIZE` entries (default 50, [config](config-reference.md)); the oldest goes when a new one arrives. A call the gateway no longer holds, never saw, or already rejected is `404 NOT_FOUND`. The buffer is not kept across a restart of the gateway, and each session has its own.

## The `call` event

`data` is a call: `{ id, from?, timestamp, isVideo, isGroup, fromMe, canHandleLocally?, webClientShouldHandle?, participants? }`. `from` is usually a `@lid` id, `timestamp` is the time the call arrived when WhatsApp gives none (it is 0 while the call rings), and `fromMe` is `false` when WhatsApp Web gives no `outgoing` flag, which is the case for every incoming call seen so far. Do not rely on `fromMe` to ignore the account's own calls: how a call placed from the linked account reaches the gateway is not verified (plan F12b). `canHandleLocally` and `webClientShouldHandle` are no longer given by WhatsApp Web and are left out. Exactly one `call` event is emitted per call id, however often WhatsApp Web touches the call again (it repeats the offer a few seconds later and again when the caller hangs up).  `participants` is not delivered for a group call yet (see TDD §2.5 and step 12.3).

## What the other wwebjs symbols map to

The fields of `Call` (`id`, `from`, `timestamp`, `isVideo`, `isGroup`, `fromMe`, `canHandleLocally`, `webClientShouldHandle`, `participants`) are the fields of the `call` event; `Call.reject` is `calls.reject`.
