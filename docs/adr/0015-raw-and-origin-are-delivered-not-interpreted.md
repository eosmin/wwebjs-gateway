# ADR 0015: `raw` and `origin` are delivered, not interpreted

Status: Accepted (2026-10-29)

## Context

A message from `whatsapp-web.js` carries `rawData`, the fields WhatsApp Web exposes that the library does
not model. One of them, `ctwaContext`, is the Click-to-WhatsApp context that Meta attaches to the first
message of a conversation started from an ad. Consumers need it; the gateway must not turn into the place
where business rules about it live. `rawData` is also not a documented, stable surface, and it can hold
personal data and very large values.

## Decision

- **`origin`** is a small, stable object read from `rawData.ctwaContext`
  (`conversionSource`, `sourceUrl`, `sourceId`, `title`, `description`, `thumbnailUrl`, `mediaUrl`,
  `ctwaClid`, plus `kind: click_to_whatsapp_ad`). A message without the context has no `origin` field. The
  gateway never invents a field; an empty string counts as missing. When `sourceId` is absent it is derived
  from a run of ten or more digits in a path segment of `sourceUrl` or `mediaUrl` (never the query string,
  never `wa.me` links, never a number that does not fit a safe integer), and the docs call it a hint until
  it is checked against a captured ad message (plan step 12.3).
- **`raw`** is `rawData` after a sanitizing copy: functions and symbols dropped, `bigint` as string, dates
  as ISO strings, cycles as `"[circular]"`, depth above 8 omitted, binary data and large base64-looking
  strings replaced by `"[omitted:<bytes>]"` (`RAW_MAX_FIELD_BYTES`).
- **Both ride on every message** in REST answers, socket events, webhook deliveries and `message_batch`.
  `INCLUDE_RAW=false` removes `raw` everywhere; a webhook can choose for itself, but cannot ask for `raw`
  while it is off. `origin` is stored in its own column, so it survives `STORE_MESSAGE_BODIES=false`.
- **The gateway only delivers this data.** What a consumer does with it (replies, matching, attribution) is
  outside the gateway and does not appear in its code or docs.

## Consequences

- The shape of `raw` mirrors WhatsApp Web and can change without notice; `origin` is stable, but the keys it
  is read from can move, in which case `origin` stops appearing until the reader is updated. A missing
  `origin` does not prove a message did not come from an ad.
- `raw` can hold personal data and counts against message storage; operators who do not need it turn it
  off.

## Alternatives considered

- **Expose the library's object as it is:** not serializable (cycles, functions) and a leak of internals.
- **Model every field of `rawData`:** a moving target that would break on each build; `raw` carries the rest.
- **Interpret the ad data in the gateway (auto-replies, lead matching):** puts consumer policy into a
  gateway meant to be shared, and cannot be undone for the consumers that rely on it.
