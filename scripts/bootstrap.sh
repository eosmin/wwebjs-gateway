#!/usr/bin/env bash
set -euo pipefail

echo "→ Checking prerequisites"
command -v node   >/dev/null || { echo "Node.js 24 required"; exit 1; }
command -v docker >/dev/null || { echo "Docker required"; exit 1; }
corepack enable >/dev/null 2>&1 || true          # pnpm version comes from package.json "packageManager"
command -v gitleaks >/dev/null || { echo "gitleaks required by the pre-commit hook: brew install gitleaks (other systems: https://github.com/gitleaks/gitleaks)"; exit 1; }
command -v openssl >/dev/null || { echo "openssl required: it generates the local secrets"; exit 1; }
command -v pnpm   >/dev/null || { echo "pnpm required: run 'corepack enable' (it may need elevated permissions)"; exit 1; }
node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$node_major" -ge 24 ] || { echo "Node.js 24+ required, found $(node -v)"; exit 1; }

echo "→ Installing dependencies (also installs the Git hooks)"
pnpm install --frozen-lockfile

echo "→ Creating the local environment file"
if [ ! -f .env.local ]; then
  # The secrets of the example are public placeholders: the local file gets its own random ones
  admin_api_key=$(openssl rand -hex 24)
  metrics_token=$(openssl rand -hex 24)
  sed -e "s|^ADMIN_API_KEY=.*|ADMIN_API_KEY=${admin_api_key}|" \
      -e "s|^METRICS_TOKEN=.*|METRICS_TOKEN=${metrics_token}|" \
      .env.example > .env.local
fi

echo "→ Starting infrastructure (postgres, redis)"
docker compose up -d --wait postgres redis

echo "→ Generating the Prisma client and migrating the database"
pnpm db:generate
pnpm db:migrate

echo "Setup complete. Run: pnpm dev"
