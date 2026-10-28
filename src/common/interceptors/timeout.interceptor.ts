import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor
} from '@nestjs/common'
import { type Observable, TimeoutError, catchError, throwError, timeout } from 'rxjs'

import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import { WhatsAppError } from '../errors.js'

// The calls that wait on WhatsApp enforce their own limits (WA_CALL_TIMEOUT_MS, SEND_SYNC_TIMEOUT_MS) and
// answer with a precise error. This is the backstop behind them, so it waits a little longer.
const GRACE_MS = 5000

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly limitMs: number

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.limitMs = Math.max(config.WA_CALL_TIMEOUT_MS, config.SEND_SYNC_TIMEOUT_MS) + GRACE_MS
  }

  // The handler cannot be cancelled, so it keeps running after the answer: only the wait ends
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      // `first`: the wait for the answer, not the silence between the emissions of a stream
      timeout({ first: this.limitMs }),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? throwError(
              () =>
                new WhatsAppError(
                  'WHATSAPP_TIMEOUT',
                  `The request took longer than ${this.limitMs} ms`,
                  {
                    timeoutMs: this.limitMs
                  }
                )
            )
          : throwError(() => error)
      )
    )
  }
}
