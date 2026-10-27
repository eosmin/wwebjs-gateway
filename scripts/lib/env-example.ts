import type { z } from 'zod'

const DECLARATION = /^(#?)\s?([A-Z][A-Z0-9_]*)=(.*)$/

// The value of a line the way an .env loader reads it: without the quotes around it
function unquote(raw: string): string {
  const value = raw.trim()
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
}

// What .env.example says against what the schema accepts: every key of the schema is declared, none
// is extra or repeated, a key left commented out is one the schema accepts as missing, and every
// value that is declared passes the schema (the file is copied to .env.local as it is)
export function findEnvExampleProblems(
  schema: z.ZodObject<Record<string, z.ZodType>>,
  text: string
): string[] {
  const declared = new Map<string, { commented: boolean; value: string }>()
  const problems: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const match = DECLARATION.exec(line)
    if (match === null) continue
    const key = match[2]
    if (key === undefined) continue
    if (declared.has(key)) problems.push(`${key} is declared twice`)
    declared.set(key, { commented: match[1] === '#', value: unquote(match[3] ?? '') })
  }

  for (const [key, schemaKey] of Object.entries(schema.shape)) {
    const entry = declared.get(key)
    if (entry === undefined) {
      problems.push(`${key} is in the schema but not declared in .env.example`)
    } else if (entry.commented) {
      if (!schemaKey.safeParse(undefined).success) {
        problems.push(`${key} is commented out, but the schema does not accept it missing`)
      }
    } else {
      const result = schemaKey.safeParse(entry.value)
      if (!result.success) {
        const reason = result.error.issues[0]?.message ?? 'the schema rejects it'
        problems.push(`${key}=${entry.value} is not valid: ${reason}`)
      }
    }
  }
  for (const key of declared.keys()) {
    if (!(key in schema.shape))
      problems.push(`${key} is declared in .env.example but not in the schema`)
  }
  return problems
}
