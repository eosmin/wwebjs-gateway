# Origin and raw data

Two optional fields of a [message](messages.md) tell where a conversation came from and what
WhatsApp Web actually delivered (TDD §6.6.1). The gateway only **delivers** this data: what a
consumer does with it is outside the gateway.

- `origin` is a small, stable object that is present when a message carries the Click-to-WhatsApp
  context that Meta attaches to the first message of a conversation started from an ad.
- `raw` is a sanitized copy of everything `whatsapp-web.js` exposes in `rawData`, for the fields the
  DTO does not model. **Its shape mirrors WhatsApp Web and can change without notice.**

Both ride on every `MessageDto`, in the REST answers, the Socket.IO events, the webhook deliveries
and the `message_batch` event ([ordering](ordering.md)).

## `origin`

`origin` is read from `rawData.ctwaContext`. A message without that context has no `origin` field
at all. Every field below can be missing, because WhatsApp may leave any of them out; the gateway
never invents one, and an empty string counts as missing.

| Field              | Type   | Where it comes from                                                                       |
| ------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `kind`             | string | Always `click_to_whatsapp_ad`                                                             |
| `conversionSource` | string | `ctwaContext.conversionSource`                                                            |
| `sourceUrl`        | string | `ctwaContext.sourceUrl`, the link of the ad                                               |
| `sourceId`         | string | `ctwaContext.sourceId` when it exists, else derived (see below)                           |
| `title`            | string | `ctwaContext.title`                                                                       |
| `description`      | string | `ctwaContext.description`                                                                 |
| `thumbnailUrl`     | string | `ctwaContext.thumbnailUrl`                                                                |
| `mediaUrl`         | string | `ctwaContext.mediaUrl`                                                                    |
| `ctwaClid`         | string | `ctwaContext.ctwaClid`, or `ctwaClid` at the top of `rawData`                             |

Example (every value is made up):

```json
{
  "kind": "click_to_whatsapp_ad",
  "conversionSource": "ad",
  "sourceUrl": "https://example.com/ads/1234567890123",
  "sourceId": "1234567890123",
  "title": "Example ad",
  "description": "Text of the ad"
}
```

### `sourceId` is best effort

When `ctwaContext.sourceId` is absent, the gateway looks for a run of ten or more digits in a path
segment of `sourceUrl`, and then of `mediaUrl` (where Meta puts the numeric id of the ad or the
post). The query string is not read, and neither are `wa.me` links, which carry a phone number or a
timestamp. A number that does not fit a safe integer is dropped instead of rounded into another id.
This derivation has not been checked against a captured ad message yet: it is finalized when a real
one is captured (plan step 12.3). Until then treat a derived `sourceId` as a hint, and prefer
`sourceUrl` when you need the exact link.

### Stability

`ctwaContext` is not a documented part of `whatsapp-web.js`: it is what WhatsApp Web happens to
carry in `rawData`. The `origin` object of the gateway is stable, but the keys it is read from can
move with a new WhatsApp Web build, in which case `origin` simply stops appearing until the reader
is updated. Do not rely on its absence to mean "not from an ad".

`origin` is also saved in its own column of the message store: with `STORE_MESSAGE_BODIES=false` the
stored copy of a message keeps `origin` but has an empty `body` and no `raw`. A `message_batch` carries the first `origin` found among its messages.

## `raw`

`raw` is `Message.rawData` after a copy that makes it safe to serialize:

- Functions and symbols are dropped; a `bigint` becomes a string; a `Date` becomes an ISO string.
- A reference cycle is written as `"[circular]"` and anything deeper than 8 levels as
  `"[omitted:depth]"`.
- Binary data (typed arrays and buffers) is written as `"[omitted:<bytes>]"`, and so is a string
  that looks like base64 (a `data:` URI included) and is larger than `RAW_MAX_FIELD_BYTES`. A long
  string that does not look like base64, such as a message body with spaces, is kept whole.
- An array item that cannot be represented becomes `null`.

### Configuration

| Variable              | Default | Effect                                                                                  |
| --------------------- | ------- | --------------------------------------------------------------------------------------- |
| `INCLUDE_RAW`         | `true`  | When `false` the gateway attaches no `raw` to any message                               |
| `RAW_MAX_FIELD_BYTES` | `8192`  | Bytes over which a base64-looking string in `raw` is replaced by `[omitted:<bytes>]`    |

A webhook can choose for itself: its `includeRaw` is `true`, `false`, or `null` to follow
`INCLUDE_RAW` ([webhooks](webhooks.md)). A webhook cannot ask for `raw` while `INCLUDE_RAW` is off:
creating or updating it with `includeRaw: true` answers `400 VALIDATION_ERROR`, because there is
nothing to include. Socket.IO events carry `raw` whenever `INCLUDE_RAW` is on.

`raw` is also kept in the stored copy of a message (the `dto` column) when `STORE_MESSAGE_BODIES` is
`true`, so it counts against the storage of the messages and goes away with them
(`MESSAGE_RETENTION_DAYS`). It can hold personal data of the people in the chat: if you do not need
it, set `INCLUDE_RAW=false`.

The full list of variables is in [config-reference](config-reference.md); the shape of
`MessageDto` is in [events](events.md#messagedto).
