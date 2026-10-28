# System endpoints

Probes, the metrics scrape and the system report. None of them needs a session.

| Route | Auth | Answers |
| --- | --- | --- |
| `GET /health` | public | Liveness: `200` while the process runs. It does not look at Postgres or Redis, so an orchestrator does not restart a process that only needs its dependencies back, and it stays `200` during shutdown. |
| `GET /ready` | public | Readiness: `200` when Postgres and Redis answer and the gateway is not shutting down, `503` otherwise. |
| `GET /metrics` | `METRICS_TOKEN` bearer or an admin key | Prometheus text format; the series are listed in [metrics.md](metrics.md). |
| `GET /v1/system/info` | admin key | Gateway, whatsapp-web.js and Node versions, uptime and the session count per status. |

## Readiness

Both probes are built on `@nestjs/terminus` and answer its result format. `/ready` pings Postgres
(`SELECT 1`) and Redis (`PING`) on every call, each bounded to 2 seconds, and says which one failed:

```json
{
  "status": "error",
  "info": { "postgres": { "status": "up", "responseTime": 3 } },
  "error": { "redis": { "status": "down", "responseTime": 2001 } },
  "details": {
    "postgres": { "status": "up", "responseTime": 3 },
    "redis": { "status": "down", "responseTime": 2001 }
  }
}
```

`status` is `ok` (200), `error` (503) or `shutting_down` (503). On `SIGTERM`/`SIGINT` Terminus
marks the result `shutting_down` before the connections close, so the balancer stops sending
traffic while in-flight work drains; `/health` then reports `shutting_down` with `200`. Use `/ready`
for the platform health check and `/health` for liveness. A failing check is logged as a warning
with the name and the reason of each indicator that is down. The reason is never in the answer:
the route is public and the message of a driver error can name hosts, ports and users.

## Metrics access

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics
```

The route is public for the API key guard and checks its own credentials: the bearer must equal
`METRICS_TOKEN` (compared in constant time), or the request must carry an admin key. When
`METRICS_TOKEN` is not set only an admin key works. Anything else is `401 UNAUTHORIZED`; a session
key is `403 INSUFFICIENT_SCOPE`.

## System info

```json
{
  "gatewayVersion": "0.0.0",
  "wwebjsVersion": "1.34.7",
  "nodeVersion": "24.20.0",
  "uptimeSeconds": 3600,
  "sessions": { "total": 2, "byStatus": { "ready": 1, "qr": 1, "failed": 0 } }
}
```

The versions are those of `package.json` (whatsapp-web.js is pinned to an exact version) and of the
running Node. `byStatus` has every status, zero included. The WhatsApp Web version of each session
is added when the session controllers arrive (step 4.6).
