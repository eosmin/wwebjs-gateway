import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PS_TIMEOUT_MS = 3000
const BYTES_PER_KIB = 1024

export type ProcessTable = (args: string[]) => Promise<string>

const ps: ProcessTable = async args => {
  const { stdout } = await run('ps', args, { timeout: PS_TIMEOUT_MS })
  return stdout
}

// `pid ppid rss` per line, rss in KiB (Linux, busybox and macOS agree on `-o rss=`)
function parseTable(output: string): Map<number, { parent: number; rssKib: number }> {
  const table = new Map<number, { parent: number; rssKib: number }>()
  for (const line of output.split('\n')) {
    const [pid, parent, rss] = line.trim().split(/\s+/).map(Number)
    if (pid === undefined || parent === undefined || rss === undefined) continue
    if (![pid, parent, rss].every(Number.isFinite)) continue
    table.set(pid, { parent, rssKib: rss })
  }
  return table
}

// The resident memory of a process and all its descendants, in bytes: Chromium splits itself into
// renderer, GPU and utility processes, and the browser pid alone shows a fraction of what a session
// costs. Undefined when `ps` is missing or the process is gone.
export async function processTreeRssBytes(
  rootPid: number,
  readTable: ProcessTable = ps
): Promise<number | undefined> {
  let table: Map<number, { parent: number; rssKib: number }>
  try {
    table = parseTable(await readTable(['-A', '-o', 'pid=,ppid=,rss=']))
  } catch {
    return undefined
  }
  if (!table.has(rootPid)) return undefined
  const members = new Set([rootPid])
  // Parents are not listed before their children, so walk until nothing new joins
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, entry] of table) {
      if (!members.has(pid) && members.has(entry.parent)) {
        members.add(pid)
        grew = true
      }
    }
  }
  let kib = 0
  for (const pid of members) kib += table.get(pid)?.rssKib ?? 0
  return kib * BYTES_PER_KIB
}
