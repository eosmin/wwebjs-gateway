// The hook hands the script a commit hash. Anything else, one that starts with "-" above all, must
// never reach git as an argument, where it would be read as an option.
export function isCommitSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)
}

// A push that only touches docs/ has no code to lint, compile or test, but the generated docs must
// still match their generator, so the docs checks still run.
export function isDocsOnly(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(file => file.startsWith('docs/'))
}
