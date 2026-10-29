// The ceilings of the send policy, shared by the environment and the per-session settings. A limit
// set to a billion would switch its rule off, and several of these numbers also size the lists of
// the state the policy saves, which is why the window of the health score cannot be larger than
// those lists (STATE_LIST_LIMIT in send-policy.state.ts).
export const SEND_POLICY_LIMITS = {
  coldSendsPerDay: 1000,
  lookupsPerDay: 10_000,
  perChatMaxPerMinute: 60,
  sessionMaxPerMinute: 600,
  sessionMaxPerHour: 10_000,
  sessionMaxPerDay: 100_000,
  intervalMs: 86_400_000,
  duplicateRecipients: 10_000,
  duplicateWindowMinutes: 1440,
  unreachableStreak: 100,
  healthWindow: 10_000
} as const
