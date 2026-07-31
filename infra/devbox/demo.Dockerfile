# BetterTrack north-star redesign demo — dev-box only (docs/deploy/devbox.md).
#
# Serves apps/redesign-demo as static files on demo.<BT_DOMAIN>. Not part of the
# production topology (§4.6): production has no demo origin.
#
# Built from the repo root so the compose `context: ..` resolves these paths:
#   docker compose -f infra/docker-compose.yml \
#                  -f infra/docker-compose.subdomains.yml \
#                  -f infra/docker-compose.devbox.yml build demo
#
# Why a build stage and not a mounted dist/: the repo .dockerignore excludes
# `**/dist` from every build context, so a pre-built dist cannot be COPYed in.
#
# TWO THINGS TO KNOW BEFORE THIS BUILDS:
#  1. apps/redesign-demo is currently UNTRACKED in git. A clone without it fails
#     at the COPY below with "no source files were specified" — by design, loudly.
#  2. It is inside the pnpm workspace glob (`apps/*`) but has NO importer entry in
#     pnpm-lock.yaml. `--frozen-lockfile` would therefore fail, and copying the
#     lockfile in would make it fail. This stage deliberately copies NO lockfile
#     and resolves fresh, which means the demo's deps are NOT pinned by this
#     build. Committing apps/redesign-demo (and its lockfile entry) is the fix.
FROM node:22-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# The workspace manifest + the two projects the demo needs. Nothing else is
# copied, so the `apps/*` / `packages/*` globs resolve to exactly these two and
# the api/web workspaces are never installed or built here.
COPY package.json pnpm-workspace.yaml ./
COPY packages/config/ ./packages/config/
COPY apps/redesign-demo/ ./apps/redesign-demo/

# `--filter <pkg>...` selects the demo plus its workspace dependencies, which
# keeps the ROOT project's devDependencies (eslint, prettier, Playwright and its
# browser download) out of this image entirely.
RUN pnpm install --no-frozen-lockfile --filter @bettertrack/redesign-demo...
RUN pnpm --filter @bettertrack/redesign-demo build

# ── runner: plain static nginx, no env-time rendering ────────────────────────
# The demo talks to no API and reads no runtime config, so unlike apps/web this
# image needs no entrypoint: one build serves every topology.
FROM nginx:alpine AS runner
COPY --from=builder /app/apps/redesign-demo/dist /usr/share/nginx/html
COPY infra/devbox/demo-nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
