FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── deps: install all workspace deps (layer-cached on lockfile change) ──────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/config/package.json ./packages/config/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

# ── build: compile TypeScript → dist/ ───────────────────────────────────────
FROM deps AS build
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
RUN pnpm --filter @bettertrack/api build

# ── deploy: create standalone production node_modules (prod deps only) ───────
FROM build AS deploy-prep
RUN pnpm deploy --filter @bettertrack/api --prod /deploy

# ── runner: minimal production image ────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S bettertrack && adduser -S bettertrack -G bettertrack

# Deploy marker (GET /api/v1/version): the commit + UTC build time this image was
# built from, passed as build args by compose (GIT_SHA/GIT_BUILD_TIME) and read
# once at boot by src/http/versionRouter.ts. Default to "unknown" for a bare
# `docker build` with no args.
ARG GIT_SHA=unknown
ARG GIT_BUILD_TIME=unknown
ENV BT_BUILD_SHA=$GIT_SHA \
    BT_BUILD_TIME=$GIT_BUILD_TIME

# Production node_modules from pnpm deploy (flat layout, no devDeps)
COPY --from=deploy-prep --chown=bettertrack:bettertrack /deploy/node_modules ./node_modules

# Built server + scripts (migrate.js, seed.js)
COPY --from=build --chown=bettertrack:bettertrack /app/apps/api/dist ./dist

# Drizzle migrations — migrate.js resolves these at ../../drizzle from dist/scripts/
COPY --from=build --chown=bettertrack:bettertrack /app/apps/api/drizzle ./drizzle

COPY --from=build --chown=bettertrack:bettertrack /app/apps/api/package.json ./

USER bettertrack
EXPOSE 3000
CMD ["node", "dist/server.js"]
