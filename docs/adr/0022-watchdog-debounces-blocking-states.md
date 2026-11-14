# ADR 0022: the watchdog needs two reads before it fails a session

Status: Accepted (2026-10-28)

## Context

The gateway has to notice a session that is stuck or blocked without turning a transient answer into a
permanent failure. A session marked `failed` is not retried while the gateway runs, so a wrong `failed`
ends the retries that would have recovered it.

## Decision

The watchdog looks at every running session each `WATCHDOG_INTERVAL_MS` (30 s) and only reads the state of
a client; for a fix it asks the session manager, which ignores a request about a run that has moved on.

- A blocking `WAState` (`UNPAIRED`, `UNPAIRED_IDLE`, `DEPRECATED_VERSION`, `TOS_BLOCK`, `PROXYBLOCK`) fails the
  session only when **two consecutive checks** read it (about 60 seconds). The second read is the debounce.
- A state that is not `CONNECTED`, a state check that throws, or one that takes over 10 seconds, is a failed
  check; `WATCHDOG_MAX_FAILURES` (3) in a row reconnects the session. One `CONNECTED` answer resets the
  count.
- `CONFLICT` counts as a failed check only when `TAKEOVER_ON_CONFLICT=true`; otherwise it is a blocking
  state.
- The watchdog publishes `session_error` with a `WATCHDOG_*` code before the status change, so a consumer
  sees the cause first.
- A session in `qr` or `pairing_code` is never restarted, and the time a person takes to scan is never
  counted against a start.

## Consequences

- A real block takes about a minute to show as `failed`; a transient answer does not end the retries.
- A `failed` session keeps `autoStart` on, so the next boot tries it once more, which is how a
  `DEPRECATED_VERSION` is solved by an upgrade.
- The memory guard shares the pass but is a separate rule (it restarts a session that is not sending).

## Alternatives considered

- **Fail on the first blocking read:** a single transient answer would end the retries.
- **Retry for ever:** a real block, such as an unpaired account, would loop and hide the cause.
- **Let the adapter alone detect failures:** a frozen page emits nothing, so something has to ask.
