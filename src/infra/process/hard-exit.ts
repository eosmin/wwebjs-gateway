import { Logger } from '@nestjs/common'

// A shutdown that does not finish (a browser that will not close, a connection that hangs) must not
// keep the container up for ever: the supervisor expects the process to leave within this time
export const HARD_EXIT_MS = 30_000

const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT']

// Starts the clock when the first stop signal arrives. The graceful shutdown itself is Nest's
// (`enableShutdownHooks`); the timer is unref'd so it never keeps a process alive that is done.
export function armHardExit(): void {
  let armed = false
  for (const signal of SIGNALS) {
    process.once(signal, () => {
      // SIGTERM followed by SIGINT must not start a second clock
      if (armed) return
      armed = true
      setTimeout(() => {
        new Logger('HardExit').fatal(`The shutdown did not finish in ${HARD_EXIT_MS / 1000} s`)
        process.exit(1)
      }, HARD_EXIT_MS).unref()
    })
  }
}
