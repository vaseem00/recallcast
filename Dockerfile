# syntax=docker/dockerfile:1
# RecallCast production image (Railway, or any Docker host with a persistent volume at /data).
# Node 24 has node:sqlite built in and unflagged (the app needs >= 24).

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- 1. dependencies (cached until package*.json change) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- 2. build (.next/standalone via output: "standalone") ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# youtubei.js is a serverExternalPackage: fail the build if it was not traced into standalone.
RUN npm run build \
 && test -f .next/standalone/server.js \
 && test -f .next/standalone/node_modules/youtubei.js/package.json

# ---- 3. runtime ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
# PORT is only a default: Railway injects its own PORT at runtime and server.js listens on it.
# NEXT_MANUAL_SIG_HANDLE: Next skips its own SIGTERM/SIGINT handlers; the app's handler
# (src/lib/jobs/worker.ts) releases running jobs, waits SHUTDOWN_GRACE_MS, then exits.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/recallcast.db \
    STORAGE_DIR=/data/storage \
    NEXT_MANUAL_SIG_HANDLE=true

# Standalone server + traced node_modules, plus the assets server.js serves itself.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node scripts/docker-entrypoint.mjs scripts/backup.mjs scripts/reset-password.mjs ./scripts/
RUN mkdir -p /data/storage && chown -R node:node /data

# Mount the persistent volume at /data (Railway: a service volume; no VOLUME instruction,
# Railway does not allow it). The entrypoint starts as root only to chown the root-owned
# volume, then drops to the unprivileged `node` user (uid 1000) before loading server.js.
EXPOSE 3000
CMD ["node", "scripts/docker-entrypoint.mjs"]
