#!/usr/bin/env bash
set -euo pipefail

echo "→ Checking prerequisites"
command -v node   >/dev/null || { echo "Node.js 24 required"; exit 1; }
command -v docker >/dev/null || { echo "Docker required"; exit 1; }
corepack enable >/dev/null 2>&1 || true          # pnpm version comes from package.json "packageManager"
command -v gitleaks >/dev/null || { echo "gitleaks required by the pre-commit hook: brew install gitleaks (other systems: https://github.com/gitleaks/gitleaks)"; exit 1; }
command -v pnpm   >/dev/null || { echo "pnpm required: run 'corepack enable' (it may need elevated permissions)"; exit 1; }
node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$node_major" -ge 24 ] || { echo "Node.js 24+ required, found $(node -v)"; exit 1; }

echo "→ Installing dependencies (also installs the Git hooks)"
pnpm install --frozen-lockfile

echo "→ Creating the local environment file"
[ -f .env.local ] || cp .env.example .env.local

echo "→ Starting infrastructure (postgres, redis)"
docker compose up -d --wait postgres redis

echo "→ Generating the Prisma client and migrating the database"
pnpm db:generate
pnpm db:migrate

echo "Setup complete. Run: pnpm dev"
