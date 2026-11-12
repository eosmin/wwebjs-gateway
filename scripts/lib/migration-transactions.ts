// Migrations that were applied before this rule. Postgres runs the statements Prisma sends in one
// call as a single implicit transaction, so each of them is atomic already; they are not edited
// because their checksum is recorded in the databases they ran on.
export const LEGACY_MIGRATIONS: ReadonlySet<string> = new Set([
  '20261027100323_init',
  '20261028100000_session_seq_high_water',
  '20261030140000_message_ack_nullable',
  '20261031180000_message_policy_handled_at',
  '20261101230000_webhook_include_raw'
])

// A migration that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) says so
// on a line of its own, with the reason
const OPT_OUT = /^--[ \t]*no-transaction:[ \t]*\S.*$/m
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /--[^\n]*/g
const CANNOT_RUN_IN_TRANSACTION = /\bCONCURRENTLY\b|^\s*VACUUM\b/im

// Limits: the split on `;` does not know string literals or `$$` bodies, so a migration that holds a
// `;` inside one needs the opt-out line (or a review that says the check is wrong).
export interface MigrationFile {
  name: string
  sql: string
}

const statementsOf = (sql: string): string[] =>
  sql
    .replace(BLOCK_COMMENT, '')
    .replace(LINE_COMMENT, '')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement !== '')

const isBegin = (statement: string): boolean => /^BEGIN(\s+TRANSACTION)?$/i.test(statement)
const isCommit = (statement: string): boolean => /^COMMIT(\s+TRANSACTION)?$/i.test(statement)

// A migration that fails halfway must leave the schema as it was: every new migration is one
// BEGIN ... COMMIT, or says why it cannot be (an opt-out with a reason, and then no BEGIN at all).
export function findTransactionProblems(
  migrations: readonly MigrationFile[],
  legacy: ReadonlySet<string> = LEGACY_MIGRATIONS
): string[] {
  const problems: string[] = []
  for (const { name, sql } of migrations) {
    if (legacy.has(name)) continue
    const statements = statementsOf(sql)
    const optOut = OPT_OUT.test(sql)
    const hasBegin = statements.some(isBegin)
    const hasCommit = statements.some(isCommit)
    if (optOut) {
      if (hasBegin || hasCommit) {
        problems.push(`migration ${name} opts out of the transaction but still has BEGIN or COMMIT`)
      }
      continue
    }
    const first = statements[0]
    const last = statements.at(-1)
    if (first === undefined || !isBegin(first) || last === undefined || !isCommit(last)) {
      problems.push(
        `migration ${name} must start with BEGIN; and end with COMMIT; (or carry a "-- no-transaction: <reason>" line)`
      )
      continue
    }
    const inside = statements.slice(1, -1)
    if (inside.some(statement => isBegin(statement) || isCommit(statement))) {
      problems.push(`migration ${name} has a BEGIN or COMMIT in the middle`)
    }
    if (inside.some(statement => CANNOT_RUN_IN_TRANSACTION.test(statement))) {
      problems.push(
        `migration ${name} has a statement that cannot run in a transaction (CONCURRENTLY, VACUUM, ALTER TYPE ... ADD VALUE): use "-- no-transaction: <reason>"`
      )
    }
  }
  return problems
}
