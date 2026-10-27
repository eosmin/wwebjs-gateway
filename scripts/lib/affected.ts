// A push that only touches docs/ has no code to lint, compile or test, but the generated docs must
// still match their generator, so the docs checks still run.
export function isDocsOnly(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(file => file.startsWith('docs/'))
}
