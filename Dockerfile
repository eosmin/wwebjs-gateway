# Debian, not Alpine: the WhatsApp library drives a Chromium that needs glibc. Chromium itself is
# installed in the step that adds the library; this image only runs the gateway for now.
FROM node:24.20.0-bookworm-slim AS base
# upgrade: the base image is pinned to a Node release, so the Debian fixes published since then are
# applied here. OpenSSL is installed because the Prisma engines are picked by the OpenSSL they find,
# in the stage that downloads them and in the one that loads them.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS pnpm
# The Git hooks are for laptops: they have nothing to hook into inside an image
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Everything the build needs, development tools included
FROM pnpm AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma prisma
COPY src src
RUN pnpm db:generate && pnpm build

# Only what runs. Scripts are off (the install hooks are for development), so the Prisma schema
# engine is fetched explicitly, and the build fails if it is not there: the runtime stage cannot
# download anything.
FROM pnpm AS prod-deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && node_modules/.bin/prisma --version \
  && find node_modules/.pnpm -name 'schema-engine-*' -type f | grep -q .

FROM base AS runtime
ENV NODE_ENV=production
# The Prisma CLI checks for updates and reports telemetry unless told not to; the migration that runs
# at start has no business calling out
ENV CHECKPOINT_DISABLE=1
# npm ships with the base image, bundles its own copies of tar, undici and others that get
# vulnerabilities, and nothing here runs it: the entrypoint calls node directly
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/package.json ./
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/prisma prisma
COPY --chmod=755 docker-entrypoint.sh ./

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
