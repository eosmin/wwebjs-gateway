#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set: the database cannot be migrated without it}"

# The schema is migrated before the gateway starts, so a gateway never runs on an old schema.
# With no migrations yet this is a no-op.
node_modules/.bin/prisma migrate deploy

# exec: the gateway becomes PID 1 and receives SIGTERM, which starts its graceful shutdown
exec node dist/main.js
