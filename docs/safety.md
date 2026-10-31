# Send policy and account safety

The gateway sends from real WhatsApp accounts. The send policy makes those accounts behave like a person having conversations, which lowers the chance of WhatsApp restricting or banning a number.

**What it does not do:** WhatsApp publishes no thresholds and gives no guarantee. Every number below is a conservative starting point, tunable per session, never a promise. The policy reduces the risk factors the gateway can see; it cannot see who reports or blocks you.

The risk factors it targets are recipients who report or block, many first messages to people who never wrote, identical text to many people, bursts, and a brand-new account with sudden volume.

## Where it runs

`SendPolicyService` evaluates every send twice:

- **At enqueue** (`check`): only cheap rejections, so the caller gets an answer at once. It never delays and never spends a budget.
- **Right before dispatch** (`admit`): the rejections again, then the pacing. `allow` spends the budgets. `delay` spends nothing; the job is queued again and asks again when it is its turn.

The decisions are:

| Decision | What the caller sees |
| --- | --- |
| `allow` | The message goes out. |
| `delay(ms)` | Nothing: the job waits in the queue. A synchronous call gets `202 { jobId, status: 'queued' }` after `SEND_SYNC_TIMEOUT_MS`. |
| `reject(code)` | `422 POLICY_BLOCKED` (or the specific code) with `details.rule`; for an asynchronous send, a `message_failed` event with the same code. |

A job the policy holds for longer than `SEND_POLICY_MAX_WAIT_MS` (30 minutes) ends as `POLICY_DELAY_EXCEEDED`, so the consumer can decide. This is separate from `SEND_MAX_WAIT_MS`, which only covers "session not ready".

## The rules, in order

1. **Suppression list.** A chat on the list rejects every send with `RECIPIENT_SUPPRESSED`, replies included. Entries come from the API and, only when the session defines `optOutKeywords` (empty by default), from an incoming message whose whole text equals one of them after lowercasing and collapsing spaces (`stop`, `baja`).
2. **Open conversation or cold send.** A chat is *open* when the contact wrote within `CONVERSATION_WINDOW_HOURS` (24), by the time the message reached the gateway (the sender's timestamp can be wrong or in the future). Replies in an open conversation skip every cold rule below. Anything else is a *cold send*.
3. **Cold sends are off by default** (`ALLOW_COLD_SENDS=false`, per session `allowColdSends`): `POLICY_BLOCKED`, rule `cold_sends_disabled`. When on: at most `COLD_SENDS_PER_DAY` (20) new chats per rolling 24 hours (`cold_sends_per_day`, a rejection), `COLD_SEND_MIN_GAP_MS` (60 s) between new chats (a delay). A chat already contacted that day does not count again. Number look-ups for cold sends are capped by `LOOKUPS_PER_DAY` (100) through `admitLookup`.
4. **Unreachable recipient** (cold sends only, `RECIPIENT_UNREACHABLE`). See below.
5. **Duplicate content** (cold sends only, `DUPLICATE_CONTENT`). The text, lowercased, with spaces collapsed and digits and links masked, was already sent to `DUPLICATE_RECIPIENTS_THRESHOLD` (5) other chats within `DUPLICATE_WINDOW_MINUTES` (10). Replies are counted as sent text, but are never refused for it.
6. **Per-chat pacing.** `PER_CHAT_MIN_INTERVAL_MS` (1.5 s) between messages to a chat and `PER_CHAT_MAX_PER_MINUTE` (10). Delays only.
7. **Session budgets.** Token buckets of `SESSION_MAX_PER_MINUTE` (20), `SESSION_MAX_PER_HOUR` (300) and `SESSION_MAX_PER_DAY` (1500). A burst is smoothed into a steady flow: the policy answers with the longest wait among the spent budgets. It never fails a send for pacing.
8. **Quiet hours** (optional, `settings.sendPolicy.quietHours { from, to, timezone }`). A cold send inside the window is delayed to its end; replies are never held. A window that ends before it starts crosses midnight. The window is read on the wall clock of the zone and its end is the next time that clock reads `to`, so the night a daylight-saving change falls inside it is an hour longer or shorter. Waiting for the end of the window is what this rule asks for, so it is not cut short by `SEND_POLICY_MAX_WAIT_MS` (it is never longer than a day); another wait of the same message that passes the limit still ends the job.

Rules 6 and 7 together with the pacing of the send queue (`SEND_MIN_INTERVAL_MS` plus jitter) space the messages of a session like a person typing.

## Warm-up

While the account is younger than `WARMUP_DAYS` (14), measured from `sessions.linkedAt` (the first successful `ready` after linking), every count budget (cold sends, look-ups, per-chat and session buckets) is multiplied by a factor that grows linearly from `WARMUP_START_FRACTION` (0.1) to 1. A scaled budget never drops below one message, and a budget set to 0 stays 0. A session that never linked is treated as brand new.

## Health throttle

The service keeps the last `HEALTH_WINDOW` (50) results of each session. Only **hard failures** count as bad: a send exception, a timeout and ack `-1`. An ack stuck at 1 does not count, because that is what an offline recipient looks like. The queue reports every result with `recordOutcome`.

Once the window holds `HEALTH_MIN_SAMPLES` (10) results and the bad ratio exceeds `HEALTH_MAX_BAD_RATIO` (0.2), every budget is halved for `HEALTH_COOLDOWN_MIN` (30) minutes and the caller publishes `session_error` with `code: 'SEND_HEALTH_DEGRADED'`. Throttling only delays: the jobs stay queued and drain at the reduced rate. After the cooldown the budgets return and the window starts empty. The minimum keeps one early failure from throttling a young session, and it is the reason a new account that fails nearly everything is slowed after 10 sends, not 50. A `HEALTH_MIN_SAMPLES` above the window counts as the window.

## Unreachable recipients

A recipient who is merely offline also leaves our messages at ack 1 until they reconnect, which looks the same as a block. The flag is therefore slow and soft. A chat is unreachable only when **all** of these hold:

- the contact sent nothing for `UNREACHABLE_MIN_AGE_HOURS` (72), and
- the last `UNREACHABLE_STREAK` (5) messages we sent are all below ack 2, and
- the oldest of them is at least that old.

Only cold sends to that chat are rejected. Replies in an open conversation never are, because an incoming message proves the contact can reach us. The decision is derived from the stored messages on every cold check, so it clears by itself when the contact writes or a later message is delivered. It never writes to the suppression list.

A flag in Redis (`policy:unreachable:<session>:<chat>`, 30-day expiry) exists only to know the moment the state changes, so `chat_unreachable` is published once when a chat becomes unreachable and once when it stops being so. `handleIncoming` clears it as soon as the contact writes; a delivered message clears it at the next cold check of that chat. If Redis cannot store the flag the decision does not change.

## Endpoints

All of them are gateway-native (nothing of whatsapp-web.js is behind them) and work whether or not the session is running. Reading needs the `read` scope, changing needs `manage`.

| Operation | Route | What it does |
| --- | --- | --- |
| `sendPolicy.get` | `GET /v1/sessions/:sessionId/send-policy` | `effective` (environment defaults with the overrides on top) and `overrides` (what the session sets itself) |
| `sendPolicy.update` | `PUT /v1/sessions/:sessionId/send-policy` | Replaces the overrides as a whole; a limit left out returns to its default and `{}` clears them. A value over a ceiling is `400`. Applies to the next decision, queued jobs included; the budgets already spent are not changed |
| `sendPolicy.usage` | `GET /v1/sessions/:sessionId/send-policy/usage` | Levels of the session buckets, new chats and look-ups of the last 24 hours against their (scaled) limits, warm-up factor, health score, throttle state, suppressed chats. Reading spends nothing |
| `suppressions.list` | `GET /v1/sessions/:sessionId/suppressions` | The list, newest first, with `reason` (`manual` or `opt_out`) and `note` |
| `suppressions.add` | `POST /v1/sessions/:sessionId/suppressions` | `{ chatId, note? }`. `chatId` is a WhatsApp id or a phone number; a number is turned into the id the sends use (the same cached look-up, which counts against `LOOKUPS_PER_DAY` when it is not cached), because an entry for the wrong id would never match. The id to suppress is the `chatId` of that contact's incoming messages. Answers `200` with `created`; a chat already listed changes nothing and publishes nothing, a new one publishes `chat_suppressed` |
| `suppressions.remove` | `DELETE /v1/sessions/:sessionId/suppressions/:chatId` | `204`, or `404` when the chat was not listed |
| `unreachableChats.list` | `GET /v1/sessions/:sessionId/unreachable-chats` | The chats flagged right now (at most 1000, `truncated` says if there are more). The flag is set and cleared when a send to the chat is checked, so the list is as of the last check |

`PUT` stores the overrides under `settings.sendPolicy` of the session, which `PATCH /v1/sessions/:sessionId` never touches. `GET /v1/sessions/:sessionId` shows them with the rest of the settings.

**Metrics.** `gw_policy_decisions_total{rule,decision}` counts every dispatch decision, every number look-up decision and every rejection at enqueue (an allow at enqueue is not counted: the dispatch decides again and is the one counted; `rule` is `none` for an allow). `gw_policy_delay_seconds` is how long the policy asked jobs to wait. `gw_suppressed_chats` is the size of all the lists. Alert on a growing `rule="state_unavailable"` or `settings_unavailable` (Redis or Postgres trouble), on `lookups_per_day` rejections and on `rule="delay_exceeded"` (jobs ending because the wait was too long).

**Not wired yet.** The send path asks the policy and feeds the health throttle, but the inbound pipeline does not call the policy yet: an incoming message does not match `optOutKeywords`, does not clear the unreachable flag, and `chat_unreachable` is only published when a send to the chat is checked. Until the pipeline hook lands (tracked in `docs/IMPLEMENTATION_PLAN.md`, "5.x, policy hooks in the inbound pipeline"), `optOutKeywords` is stored and returned but no message suppresses a chat by itself; use `POST …/suppressions`.

## Per-session settings

`settings.sendPolicy` overrides the defaults for one session (change it with `PUT …/send-policy`). A key left out keeps the environment value; an invalid object is ignored (and logged) and the defaults apply.

| Key | Overrides |
| --- | --- |
| `allowColdSends` | `ALLOW_COLD_SENDS` |
| `coldSendsPerDay` | `COLD_SENDS_PER_DAY` |
| `coldSendMinGapMs` | `COLD_SEND_MIN_GAP_MS` |
| `lookupsPerDay` | `LOOKUPS_PER_DAY` |
| `perChatMinIntervalMs` | `PER_CHAT_MIN_INTERVAL_MS` |
| `perChatMaxPerMinute` | `PER_CHAT_MAX_PER_MINUTE` |
| `sessionMaxPerMinute` | `SESSION_MAX_PER_MINUTE` |
| `sessionMaxPerHour` | `SESSION_MAX_PER_HOUR` |
| `sessionMaxPerDay` | `SESSION_MAX_PER_DAY` |
| `optOutKeywords` | none (empty by default) |
| `quietHours` | none (off by default) |

The other variables of the policy (`CONVERSATION_WINDOW_HOURS`, the warm-up, the duplicate guard, the unreachable and health settings) are global. All of them are listed in [config-reference.md](config-reference.md).

## State, restarts and failures

What the budgets have spent (the session buckets, the pacing per chat, the cold chats of the last 24 hours, the look-ups, the recent content and the health window) is one JSON document per session in Redis, `policy:state:<session>`, with a two-day expiry. It is checked with a schema (bounded lists, bounded ids, no unknown keys) when it is read.

- **Restarts.** A decision that spends a budget is saved before it is returned, so a restart or a crash loop does not hand the budgets out again. The buckets resume from the time they were saved, and a throttle that was running keeps running.
- **Fail closed.** If the state cannot be read or the spending cannot be saved, the answer is `delay` (rule `state_unavailable`, 5 s), never `allow`, and nothing is spent in memory. Every call to Redis has a 2-second deadline, because the connection of the gateway waits for Redis forever by design; without the deadline an outage would hang the dispatch instead of delaying it. The same holds for a failure while reading Postgres at dispatch. After a save that failed the copy in memory is dropped and the next call reads Redis again, since a save that timed out may still have arrived. The job ends as `POLICY_DELAY_EXCEEDED` if this lasts longer than `SEND_POLICY_MAX_WAIT_MS`. The enqueue check lets the message in when the state is unavailable, so the dispatch decides; it throws on a Postgres failure and never answers `allow` for it.
- **An unreadable saved state** (not JSON, a different shape, a tampered or oversized list) is not a reason to start from full budgets: the session starts throttled (budgets halved) for `HEALTH_COOLDOWN_MIN`, and an error is logged. This can still make a session briefly more permissive than its true history, so look at that log line.
- **Deadlines on Postgres too.** The database reads of a decision run inside the per-session lock, so each has a 5-second deadline; a query that hangs becomes a `delay` and does not stop the other sends of the session.
- **Opt-outs are honored even with broken settings.** `optOutKeywords` is read on its own when the rest of `settings.sendPolicy` is invalid. If it cannot be read at all, `handleIncoming` throws and logs an error so the inbound pipeline can retry; it never silently ignores a contact who asked to stop.
- **Ids.** A recipient id longer than 128 characters is refused (`POLICY_BLOCKED`, rule `invalid_chat_id`), because the saved state could not hold it.
- **Deleting a session.** Stop its sends first, then call `forget`; a later call would start a new state for an id that no longer exists. A read that was in flight during the delete is discarded.
- **Known gap.** A health result that cannot be saved (Redis down) is kept in memory only; a restart or a later failed save loses it, so a throttle that tripped in that moment may not survive.
- **Invalid settings.** A missing session row or a `settings.sendPolicy` that no longer passes the schema never falls back to the defaults, which could be looser than what the session had. The last valid settings stay in force; with none, the answer is `delay` (rule `settings_unavailable`). The log names the keys that are wrong, never their values. Every limit has a ceiling, in the session settings and in the environment variables of the policy alike (for example 600 messages per minute, 100 000 per day, a health window of at most 10 000), so a typo cannot switch a rule off or make the saved state too big to read back.
- **No message text.** The duplicate-content guard stores a keyed digest (HMAC-SHA256 with a key derived from `ADMIN_API_KEY`, which is not stored in Redis) of the normalized text, never the text, and short templates cannot be recovered by hashing guesses. Rotating `ADMIN_API_KEY` only forgets the last 10 minutes of that guard.
- **Phone numbers do live in Redis.** The chat ids of the state (two days) and the unreachable flags (30 days) are WhatsApp ids, which contain a phone number. They are never logged. Treat the Redis of the gateway like its database.
- **Clocks.** The saved times are compared against the clock of this machine and never ahead of it, so a clock that was set back does not make a chat wait for a time that is in the future.
- **One at a time.** The operations that change a session's state run one after another per session, inside the process. A state read that is slow cannot bring back a budget that a later decision spent, nor a session that was deleted meanwhile. This is enough because the gateway runs a single instance, so never run two replicas against one Redis.
- **From Postgres.** Whether a chat is open, whether it is unreachable, the suppression list and the warm-up (`linkedAt`) come from the database on every call, so they survive anything.
- **Settings cache.** `settings.sendPolicy` is cached for 30 seconds per session and read again at once when the settings endpoint changes it.

Be careful with `optOutKeywords`: a keyword that is also an ordinary reply ("no", "ok") suppresses the chat for good the first time a contact says it. Use words only an opt-out would say.

## Operational checklist

These cannot be enforced in code:

- Use numbers with history and a real SIM, not freshly created ones; complete the profile (name, photo).
- Keep WhatsApp on the phone updated and connected at least every few days: linked devices are unlinked after about 14 days offline.
- One gateway instance per session, and never the same session open elsewhere. Keep a stable server IP and region per number and avoid frequent relinks.
- Scale volume gradually over weeks.
- Write messages people want to receive and make it easy to stop. Never buy lists or message people who did not initiate.
- For business-initiated outreach at scale, use the official WhatsApp Business Platform instead of this gateway.
