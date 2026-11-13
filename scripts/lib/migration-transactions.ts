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
// Statements Postgres refuses inside a transaction block (or that a later statement of the same
// block cannot use: `ADD VALUE` of an enum)
const CANNOT_RUN_IN_TRANSACTION =
  /\bCONCURRENTLY\b|^\s*VACUUM\b|^\s*(?:CREATE|DROP)\s+(?:DATABASE|TABLESPACE)\b|^\s*ALTER\s+SYSTEM\b|^\s*ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i

// Limits: the split on `;` does not know string literals (a `;` inside one needs the opt-out line, or a
// review that says the check is wrong); `$$` bodies are skipped.
export interface MigrationFile {
  name: string
  sql: string
}

// A dollar-quoted body (`$$ ... $$`, `$body$ ... $body$`) holds `;` and words such as `END` that are not
// statements of the migration: it is replaced by a placeholder before the split
const DOLLAR_QUOTED = /\$(\w*)\$[\s\S]*?\$\1\$/g

const statementsOf = (sql: string): string[] =>
  sql
    .replace(BLOCK_COMMENT, '')
    .replace(LINE_COMMENT, '')
    .replace(DOLLAR_QUOTED, "''")
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement !== '')

const isBegin = (statement: string): boolean => /^BEGIN(\s+TRANSACTION)?$/i.test(statement)
const isCommit = (statement: string): boolean => /^COMMIT(\s+TRANSACTION)?$/i.test(statement)
// Anything that ends the transaction block early (`END` is COMMIT, `ABORT` is ROLLBACK, and
// `COMMIT AND CHAIN` opens another): the statements after it would run outside the block
const endsTransaction = (statement: string): boolean =>
  /^(?:COMMIT|END|ABORT|ROLLBACK(?!\s+TO\b))\b/i.test(statement)

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
    if (inside.some(statement => isBegin(statement) || endsTransaction(statement))) {
      problems.push(`migration ${name} has a BEGIN, COMMIT, END, ABORT or ROLLBACK in the middle`)
    }
    if (inside.some(statement => CANNOT_RUN_IN_TRANSACTION.test(statement))) {
      problems.push(
        `migration ${name} has a statement that cannot run in a transaction (CONCURRENTLY, VACUUM, CREATE or DROP DATABASE or TABLESPACE, ALTER SYSTEM, ALTER TYPE ... ADD VALUE): use "-- no-transaction: <reason>"`
      )
    }
  }
  return problems
}
