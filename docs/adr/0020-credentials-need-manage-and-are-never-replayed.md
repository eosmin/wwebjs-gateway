# ADR 0020: the QR and pairing code need `manage`, and a redacted credential is never replayed

Status: Accepted (2026-10-29)

## Context

The TDD first said that the `read` scope covers every GET. But the QR code of a session is a credential
until it is scanned: whoever scans it links a device to the account and then reads and sends as it, and
the pairing code does the same. `read` is in the default scopes of a new key, so a key made for a consumer
that only reads would be able to ask for it. Separately, the stored copy of a `qr` or `code` event is
redacted, so replaying it to a webhook would send `[Redacted]` as if it were a code.

## Decision

- `GET /v1/sessions/:sessionId/qr`, `GET .../qr.png`, `POST .../pairing-code` and `DELETE .../pairing-code`
  are **`manage`**. Both
  answer `Cache-Control: no-store`, keep the code in memory only, and never write it to a log or the
  database. The scope is visible in the OpenAPI document as `x-scope`.
- A webhook that subscribes to `qr` or `code` also needs `manage`, on top of `webhooks`.
- A manual `retry` of a `qr` or `code` delivery answers `400`, and `retry-failed` skips them. The automatic
  retries of a fresh delivery carry the real value in the job, so they work.

## Consequences

- Tightening later would break consumers and loosening is one line, so the strict side was taken first.
- A consumer that wants to show the QR to a person needs a key with `manage`, which is a larger power than
  `read`; the key can be limited to its session.
- A failed delivery of a code is not recoverable from the stored copy; the session emits a new code.

## Alternatives considered

- **Keep QR under `read` as the TDD said:** hands a login credential to every default key.
- **Resend the redacted copy on retry:** tells the receiver nothing and looks like a valid event.
- **Store the unredacted code to allow retries:** puts a credential in the database for the sake of a
  retry of something that expires within seconds.
