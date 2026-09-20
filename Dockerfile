# syntax=docker/dockerfile:1
#
# WELCOME — self-hosting image.
#
# WHY FOUR STAGES. The runtime image must not contain a compiler, a test runner
# or a devDependency: `next start` needs the build output and the packages the
# app imports at runtime, and nothing else. Splitting `deps` (all deps, needed to
# BUILD), `build` (the Next build), `prod-deps` (`pnpm install --prod`) and
# `runtime` keeps exactly one of those four in the final layer set.
#
# WHY `next start` AND NOT `output: 'standalone'`. Standalone output is the
# documented Next recipe for containers, but enabling it is a change to
# next.config.ts — which is also the file the live deployment builds from, and
# this work is explicitly not allowed to touch that deployment's behaviour. The
# same result (production dependencies only) is reached here by installing them
# into their own stage.
#
# NO AUTHOR VALUES, NO SECRETS. Nothing about a particular deployment is baked
# in: no domain, no operator address, no key. Every value is read from the
# environment at runtime — see SELF_HOSTING.md §4.7 and docker-compose.yml, which
# pass the operator's own `.env` through.

# ---------------------------------------------------------------------------
# Base: the toolchain every stage shares.
#
# pnpm is installed from npm rather than through corepack because corepack needs
# a `packageManager` field in package.json to pin a version, and this repository
# does not set one. `pnpm@10` matches the "pnpm 10.x" requirement stated in
# SELF_HOSTING.md §2 and the lockfile's format.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
# Telemetry is off in the image, not in the source: a self-hoster's build should
# not phone home, and the setting must not leak into other environments.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — every dependency (dev included), for the build.
# ---------------------------------------------------------------------------
FROM base AS deps
# Copied alone so this layer is cached until the dependency set itself moves:
# source edits do not invalidate an install.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile the application.
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build reads no application secret: next.config.ts resolves redirect rules
# from env with defaults, and every route that needs configuration reads it
# lazily at request time (src/lib/env.ts). A missing secret therefore fails at
# the first request that needs it, not here — which is why this stage needs no
# env file and the image can be built before the operator's `.env` exists.
#
# `.next/cache` is deleted ON PURPOSE, in the same layer that created it: it is
# the incremental-build cache (80 MB in this project), it is useless to
# `next start`, and it contains transformed copies of application sources — the
# last thing a runtime image should carry. Removing it here rather than in the
# runtime stage keeps it out of the image layers entirely.
RUN pnpm build && rm -rf .next/cache

# ---------------------------------------------------------------------------
# prod-deps — production dependencies only, for the image.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ---------------------------------------------------------------------------
# runtime — the image that runs.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Non-root by construction (uid/gid 1001), created before the COPYs so every
# file lands owned by it. `docker compose exec app id` is the check.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# Production dependencies only — the whole point of the `prod-deps` stage.
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
# Build output, read-only at runtime.
COPY --from=build --chown=nextjs:nodejs /app/.next ./.next
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json
# `next start` re-reads the config on every boot, and next.config.ts imports
# ./src/lib/legacy-host-redirect — so that one module is part of the runtime
# surface even though the rest of src/ is already compiled into .next.
COPY --from=build --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
COPY --from=build --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=nextjs:nodejs /app/src/lib/legacy-host-redirect.ts ./src/lib/legacy-host-redirect.ts
# Migrations + their runner. `docker-compose.yml` runs this as a one-shot
# `migrate` service before the app starts; keeping it in the image is what makes
# the stack self-contained (no pnpm, no source checkout needed on the host).
COPY --from=build --chown=nextjs:nodejs /app/db ./db
COPY --from=build --chown=nextjs:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs

USER nextjs
EXPOSE 3000

# Invoked through `node` rather than the node_modules/.bin shim: the shim is a
# symlink resolved by PATH/exec semantics, and pointing at the real entry point
# removes that variable from a crash-on-boot.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
