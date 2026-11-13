# Debian, not Alpine: the WhatsApp library drives a Chromium that needs glibc. Chromium itself is
# installed in Phase 11 (Docker and deployment); until then the image only runs the gateway, and a
# session cannot start without PUPPETEER_EXECUTABLE_PATH.
FROM node:24.20.0-bookworm-slim AS base
# upgrade: the base image is pinned to a Node release, so the Debian fixes published since then are
# applied here. OpenSSL is installed because the Prisma engines are picked by the OpenSSL they find,
# in the stage that downloads them and in the one that loads them. procps provides `ps`, which the
# memory guard of the watchdog uses to measure the browsers (the slim image has none).
# APT_CACHE_BUST: CI caches the layers (type=gha), and the text of the RUN below never changes, so
# its layer would stay cached and never receive a Debian fix. CI passes the ISO year-week, so the
# layer is rebuilt once a week. It is declared right before the RUN and used nowhere else.
ARG APT_CACHE_BUST=dev
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl procps \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS pnpm
# The Git hooks are for laptops: they have nothing to hook into inside an image
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm applies the patch of whatsapp-web.js while it installs
COPY patches patches

# Everything the build needs, development tools included
FROM pnpm AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma prisma
COPY src src
RUN pnpm db:generate && pnpm build

# Only what runs. Scripts are off (the install hooks are for development), so the Prisma schema
# engine is fetched explicitly, and the build fails if it is not there: the runtime stage cannot
# download anything. The library is loaded only when a session starts, so nothing in the smoke of CI
# would notice a missing patch: the build looks for a line only the patch has (the marker the send
# reads to tell a failure after the dispatch) and fails without it.
FROM pnpm AS prod-deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && node_modules/.bin/prisma --version \
  && find node_modules/.pnpm -name 'schema-engine-*' -type f | grep -q . \
  && { grep -q 'afterDispatch: true' node_modules/whatsapp-web.js/src/Client.js \
    || { echo 'the whatsapp-web.js patch is not in the image' >&2; exit 1; }; }

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

# The saved logins and the WhatsApp Web cache live under /data, which a volume replaces in
# production. The gateway refuses to start on a folder it cannot write, and /app belongs to root, so
# the folders exist and belong to the user the process runs as.
ENV WWEBJS_DATA_PATH=/data/wwebjs_auth \
    WWEB_CACHE_PATH=/data/wwebjs_cache
RUN mkdir -p /data/wwebjs_auth /data/wwebjs_cache && chown -R node:node /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
