# ADR 0013: a send policy that behaves like a person, with cold sends off by default

Status: Accepted (2026-10-28)

## Context

The gateway automates real WhatsApp accounts. WhatsApp publishes no thresholds and gives no guarantee, and
automation can get a number restricted or banned whatever the gateway does. The factors the gateway can
see are many first messages to people who never wrote, identical text to many people, bursts, recipients
who block, and a new account with sudden volume. The intended use is conversations the contact started.

## Decision

`SendPolicyService` evaluates every send twice: at enqueue (cheap rejections only, so the caller learns at
once) and right before dispatch (the rejections again, then pacing; only an `allow` spends budgets). The
rules, in order: the suppression list; open conversation versus cold send; cold sends; unreachable
recipient and duplicate content (cold sends only); per-chat pacing; token-bucket budgets per session
(minute, hour, day); optional quiet hours.

- **A send to a chat that did not write within `CONVERSATION_WINDOW_HOURS` is a cold send, and cold sends are
  off by default** (`ALLOW_COLD_SENDS=false`, per session `allowColdSends`). Enabling them is an explicit
  act, and even then they are capped per day and spaced apart.
- **Replies in an open conversation skip the cold rules,** because an incoming message proves the contact
  can reach the account. A reply is never held by quiet hours and never refused as duplicate content.
- **Budgets are smoothed, not failed:** a burst gets the longest wait among the spent budgets, so pacing
  delays and never turns into an error. Delays beyond `SEND_POLICY_MAX_WAIT_MS` end as
  `POLICY_DELAY_EXCEEDED`.
- **A new account is warmed up:** for `WARMUP_DAYS` from the first successful `ready`, count budgets are
  scaled up from a fraction to full.
- **A health throttle:** a high ratio of hard failures halves the budgets for a cooldown and publishes
  `session_error` (`SEND_HEALTH_DEGRADED`).
- **Limits are tunable per session** (`PUT .../send-policy`, scope `manage`) within ceilings. The
  suppression list is honoured for every send, replies included.

## Consequences

- A fresh installation cannot message people who never wrote to it until its operator turns cold sends on.
  That is the intended default for the safety of the account, and a visible rejection (`POLICY_BLOCKED`,
  rule `cold_sends_disabled`) says why.
- Every number is a conservative starting point, never a promise; the guide says so.
- The policy sees what the gateway sees. It cannot see who reports or blocks, and an offline recipient
  looks like a block, which is why the unreachable flag is slow and soft and never writes to the
  suppression list.

## Alternatives considered

- **No policy, leaving limits to the consumer:** every consumer would reimplement it, or none would.
- **Cold sends on by default:** the quickest way to a banned number for the least careful operator.
- **Fail a send that exceeds a budget:** turns a burst into a flood of errors that consumers retry.
  Smoothing keeps the order and the intent.
- **Hard global limits only:** do not separate a reply in a live conversation from a first message, which
  carry very different risk.
