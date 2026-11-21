// Runs Jest with the arguments it is given and fails the run when a worker leaked a handle. Jest only
// warns about that (the suites still pass), and a leak left alone hides the next one.
// Usage: tsx scripts/jest-strict.ts [jest arguments]
import { spawn } from 'node:child_process'
import { argv, exit, stderr, stdout } from 'node:process'

import { hasWorkerLeak } from './lib/jest-leak.js'

const child = spawn('pnpm', ['exec', 'jest', ...argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'pipe'],
  // The pipes below are not a terminal, so Jest would drop its colors
  env: { ...process.env, FORCE_COLOR: stdout.isTTY ? '1' : (process.env['FORCE_COLOR'] ?? '0') }
})

// A cancelled CI job or a closed terminal ends the wrapper, not Jest behind it
for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))
child.on('error', error => {
  console.error(`Could not start Jest: ${error.message}`)
  exit(1)
})

let output = ''
child.stdout.on('data', (chunk: Buffer) => {
  output += chunk.toString()
  stdout.write(chunk)
})
child.stderr.on('data', (chunk: Buffer) => {
  output += chunk.toString()
  stderr.write(chunk)
})
child.on('close', code => {
  if (code === 0 && hasWorkerLeak(output)) {
    console.error(
      'Jest force exited a worker: a spec leaves a timer, socket or connection open. ' +
        'Find it with `pnpm exec jest --detectOpenHandles <spec>` and close it in its teardown.'
    )
    exit(1)
  }
  exit(code ?? 1)
})
