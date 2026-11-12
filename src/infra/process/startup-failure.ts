import { scrubText } from '../logger/redaction.js'

// The line the process writes to stderr when it fails to start, before the logger exists. The
// message of a driver can quote the connection string it was given, so it goes through the same
// scrubbing as every log line: a container log is read by more people than the environment is.
export function formatStartupFailure(error: unknown): string {
  const reason = scrubText(error instanceof Error ? error.message : String(error))
  return `${JSON.stringify({ level: 'fatal', msg: `Startup failed: ${reason}` })}\n`
}
