FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── deps: install all workspace deps (layer-cached on lockfile change) ──────
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/config/package.json ./packages/config/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# ── build: Vite production build → apps/web/dist/ ───────────────────────────
COPY packages/ ./packages/
COPY apps/web/ ./apps/web/
# Deploy marker baked into the bundle (admin-login footer). Vite only exposes
# VITE_-prefixed vars to the client and reads them from the build environment,
# so these must be set as ENV BEFORE `pnpm build`. Passed as build args by
# compose (GIT_SHA/GIT_BUILD_TIME); default to "unknown" for a bare build.
ARG GIT_SHA=unknown
ARG GIT_BUILD_TIME=unknown
ARG VITE_GOOGLE_DRIVE_CLIENT_ID
ENV VITE_BUILD_SHA=$GIT_SHA \
    VITE_BUILD_TIME=$GIT_BUILD_TIME \
    VITE_GOOGLE_DRIVE_CLIENT_ID=$VITE_GOOGLE_DRIVE_CLIENT_ID
RUN pnpm --filter @bettertrack/web build

# ── runner: nginx front proxy — fronts web/admin/api origins, both modes ─────
FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752 AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
# Drop the stock catch-all server; our entrypoint renders the real config from
# the selected mode template into conf.d/default.conf at start.
RUN rm -f /etc/nginx/conf.d/default.conf
# Mode templates (subdomains|ports) live outside /etc/nginx/templates so the
# stock envsubst step never mangles nginx's own $variables.
COPY infra/nginx/templates/ /etc/nginx/bt-templates/
COPY infra/nginx/docker-entrypoint.sh /usr/local/bin/bt-web-entrypoint.sh
RUN chmod +x /usr/local/bin/bt-web-entrypoint.sh
# 80 (subdomains) + the ports-mode service ports; publish per mode in compose.
EXPOSE 80 3000 8080 8081
ENTRYPOINT ["/usr/local/bin/bt-web-entrypoint.sh"]
