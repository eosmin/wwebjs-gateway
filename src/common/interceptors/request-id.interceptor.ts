import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Observable } from 'rxjs'

import { REQUEST_ID_HEADER } from '../../infra/logger/logger.config.js'

// Answers with the id Fastify chose for the request (createFastifyAdapter), the one the logs carry.
// AllExceptionsFilter sets the same header, which covers the failures that never reach a handler.
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const http = context.switchToHttp()
      void http
        .getResponse<FastifyReply>()
        .header(REQUEST_ID_HEADER, http.getRequest<FastifyRequest>().id)
    }
    return next.handle()
  }
}
