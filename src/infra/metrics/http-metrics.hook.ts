import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import type { FastifyInstance } from 'fastify'

import { MetricsService } from './metrics.service.js'

const MS_PER_SECOND = 1000

// A Fastify hook rather than a Nest interceptor so that every response is counted, including the ones a
// guard rejects and the routes that do not exist. The label is the route pattern, never the URL, so ids
// do not multiply the series; a request no route matched is `unmatched`.
@Injectable()
export class HttpMetricsHook implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  onModuleInit(): void {
    const { httpAdapter } = this.host
    if (httpAdapter === undefined) return
    const { httpRequests, httpDurationSeconds } = this.metrics.metrics
    httpAdapter.getInstance<FastifyInstance>().addHook('onResponse', (request, reply, done) => {
      const labels = { method: request.method, route: request.routeOptions.url ?? 'unmatched' }
      httpRequests.inc({ ...labels, status: String(reply.statusCode) })
      httpDurationSeconds.observe(labels, reply.elapsedTime / MS_PER_SECOND)
      done()
    })
  }
}
