const ROLLBACK_SUFFIX = '.rollback.sql'

// Each Prisma migration folder needs its rollback script, and each rollback script needs its folder
export function findRollbackProblems(
  migrations: readonly string[],
  rollbacks: readonly string[]
): string[] {
  const rollbackNames = new Set(
    rollbacks
      .filter(file => file.endsWith(ROLLBACK_SUFFIX))
      .map(file => file.slice(0, -ROLLBACK_SUFFIX.length))
  )
  const migrationNames = new Set(migrations)
  return [
    ...migrations
      .filter(name => !rollbackNames.has(name))
      .map(name => `migration ${name} has no rollbacks/${name}${ROLLBACK_SUFFIX}`),
    ...[...rollbackNames]
      .filter(name => !migrationNames.has(name))
      .map(name => `rollbacks/${name}${ROLLBACK_SUFFIX} matches no migration`)
  ]
}
