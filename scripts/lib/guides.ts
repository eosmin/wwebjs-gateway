// Every guide the project has to ship (TDD §6.13), as a path under docs/. Phase 9 writes the
// hand-written ones; until a guide is written it sits in PENDING_GUIDES, and the docs spec fails
// the moment a guide exists without having left that list.
export const WRITTEN_GUIDES: readonly string[] = [
  'docs/architecture.md',
  'docs/authentication.md',
  'docs/broadcasts.md',
  'docs/calls.md',
  'docs/channels.md',
  'docs/chats.md',
  'docs/config-reference.md',
  'docs/contacts.md',
  'docs/errors.md',
  'docs/events.md',
  'docs/faq.md',
  'docs/getting-started.md',
  'docs/groups.md',
  'docs/labels.md',
  'docs/limits.md',
  'docs/lookup.md',
  'docs/messages.md',
  'docs/metrics.md',
  'docs/openapi.json',
  'docs/operations-list.md',
  'docs/operations.md',
  'docs/ordering.md',
  'docs/origin.md',
  'docs/parity-matrix.md',
  'docs/presence-profile.md',
  'docs/reactions-and-receipts.md',
  'docs/safety.md',
  'docs/send-queue.md',
  'docs/sessions.md',
  'docs/system.md',
  'docs/troubleshooting.md',
  'docs/webhooks.md',
  'docs/websocket-commands.md',
  'docs/websocket.md'
]

// Required by the TDD and not written yet: step 9.5 writes each one and takes it out of this list
// (the guides of use are written; the project and operations guides are the last PR of the step)
export const PENDING_GUIDES: readonly string[] = [
  'docs/backup-restore.md',
  'docs/contributing.md',
  'docs/deploy-railway.md',
  'docs/deploy-vps.md',
  'docs/development.md',
  'docs/repository-settings.md',
  'docs/upgrading.md'
]

// The environment variables each feature guide has to mention (TDD §6.13, docs test 7): the ones
// whose name matches. The spec checks against the real schema, so a new variable of a feature is
// caught when it is added. A guide that is still pending is checked once 9.5 writes it.
export const FEATURE_ENV: Readonly<Record<string, RegExp>> = {
  'docs/ordering.md': /^(INBOUND_(ORDER|LATE)|MESSAGE_BATCH_|RECONCILE_)/,
  'docs/origin.md': /^(INCLUDE_RAW|RAW_MAX_FIELD_BYTES)$/,
  'docs/safety.md':
    /^(CONVERSATION_WINDOW_HOURS|ALLOW_COLD_SENDS|COLD_SEND|LOOKUPS_PER_DAY|PER_CHAT_|SESSION_MAX_PER_|DUPLICATE_|WARMUP_|UNREACHABLE_|SEND_POLICY_MAX_WAIT_MS|HEALTH_|HUMANIZE_MIN_REPLY_DELAY_MS)/
}
