# Presence, profile and settings

The routes under `/v1/sessions/:sessionId` that change how the linked account looks and behaves (TDD §6.11). Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). All of them need the `manage` scope and answer `204` with no body.

| Operation                | Route                          | Body                                       |
| ------------------------ | ------------------------------ | ------------------------------------------ |
| `presence.set`           | `POST …/presence`              | `{ state: "available" \| "unavailable" }`  |
| `profile.setStatus`      | `PUT …/profile/status`         | `{ status }` (1 to 139 characters)         |
| `profile.setDisplayName` | `PUT …/profile/display-name`   | `{ displayName }` (1 to 25 characters)     |
| `profile.setPicture`     | `PUT …/profile/picture`        | `{ source }`: `base64`, `url` or `messageId` |
| `profile.deletePicture`  | `DELETE …/profile/picture`     | none                                       |
| `settings.update`        | `PUT …/settings`               | any of the five settings below, at least one |

## Presence

`available` shows the account as online; `unavailable` as offline. While the account is available the linked phone gets no push notifications, so a bot that stays `available` all day silences the phone of the owner. The gateway does not keep the presence: it is whatever was sent last, and it is not sent again after a restart of the session.

## Profile

- **`profile.setStatus`** is the "about" text; `profile.setDisplayName` the name the account shows. The limits are WhatsApp's own; text outside them is `400 VALIDATION_ERROR`, spaces around the text are trimmed. A name WhatsApp refuses is `502 WHATSAPP_ERROR`.
- **`profile.setPicture`** takes the same `source` as a media message: inline `base64` with its `mimetype`, a public `url` (SSRF guard, `MAX_MEDIA_BYTES` cap, download timeout) or the `messageId` of a message whose media is used (`404 NOT_FOUND` if it has none). A source that is not an image (`image/*`) is `400`. The body of a request is limited to 1 MiB, so a larger image goes by `url`.
- **`profile.deletePicture`** removes the picture. Both picture routes answer `502 WHATSAPP_ERROR` when WhatsApp says it did not do it.

## Settings of the account (`settings.update`)

`PUT …/settings` with any of `autoDownloadAudio`, `autoDownloadDocuments`, `autoDownloadPhotos`, `autoDownloadVideos` and `backgroundSync` (booleans). At least one is required and an unknown field is a `400`.

WhatsApp has no call that sets several at once, so the gateway applies them one by one in the order above and **stores what it applied in the settings of the session** (the same keys `PATCH /v1/sessions/:sessionId` takes, see [sessions.md](sessions.md)), so the session applies them again every time it is ready: a restart or a reconnect does not undo them. **If one fails, the ones before it stay applied and stored, and the ones after it are not touched**; `GET /v1/sessions/:sessionId` shows which ones took, and sending the request again with the same body is safe. These are the settings of the WhatsApp Web page; the other settings of the session (ordering, humanize, send policy) are not touched here.

## Errors

`SESSION_NOT_READY` (409), `VALIDATION_ERROR` (400), `NOT_FOUND` (404, a `messageId` without media), `PAYLOAD_TOO_LARGE` (413), `MEDIA_FETCH_FAILED` (422), `INSUFFICIENT_SCOPE` (403) and `WHATSAPP_ERROR` / `WHATSAPP_TIMEOUT` (502 / 504). See [errors.md](errors.md).
