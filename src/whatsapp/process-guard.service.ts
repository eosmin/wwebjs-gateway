import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown
} from '@nestjs/common'

import { isPuppeteerFailure } from './wa-call.js'
import { WatchdogService } from './watchdog.service.js'

type FailureKind = 'unhandledRejection' | 'uncaughtException'

const FATAL_EXIT_CODE = 1

// Only the name and the stack frames leave: the message of a library error can carry a chat id, a phone
// number, page text or a connection string, and these logs are read by more people than the data is
function describeFatal(reason: unknown): string {
  if (!(reason instanceof Error)) return `a ${typeof reason} was thrown, not an Error`
  const frames = (reason.stack ?? '').split('\n').filter(line => /^\s+at /.test(line))
  return [reason.name, ...frames].join('\n')
}

// A rejection that nobody handles ends a Node process. Two kinds reach this guard. One that says the
// browser of a session died comes from wwebjs itself (its `framenavigated` handler, its
// `exposeFunction` callbacks), from no call of ours, and names no session: it is not attributed by
// guessing. Every running session is checked now instead of at the next tick, and the watchdog
// reconnects the ones that stopped answering, as it does for any other dead browser. A check that finds a pass already running does nothing: the
// rejections of one dying browser come in a burst, and the pass in flight covers it. Anything else is
// a bug of ours, and the process state is unknown: it logs fatal and exits so the supervisor restarts it clean.
//
// Stays installed through the shutdown: closing the browsers is what raises most of these rejections.
@Injectable()
export class ProcessGuardService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProcessGuardService.name)
  private readonly onRejection = (reason: unknown): void => {
    this.handle('unhandledRejection', reason)
  }
  private readonly onException = (error: unknown): void => {
    this.handle('uncaughtException', error)
  }

  constructor(@Inject(WatchdogService) private readonly watchdog: WatchdogService) {}

  onApplicationBootstrap(): void {
    process.on('unhandledRejection', this.onRejection)
    process.on('uncaughtException', this.onException)
  }

  onApplicationShutdown(): void {
    process.off('unhandledRejection', this.onRejection)
    process.off('uncaughtException', this.onException)
  }

  private handle(kind: FailureKind, reason: unknown): void {
    if (isPuppeteerFailure(reason)) {
      this.logger.warn(`${kind} from the browser side of a session; checking every session now`)
      this.watchdog.check().catch((error: unknown) => {
        this.logger.error(`The check after ${kind} failed to run`, error)
      })
      return
    }
    this.logger.fatal(describeFatal(reason), kind)
    process.exit(FATAL_EXIT_CODE)
  }
}
