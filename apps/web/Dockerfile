FROM node:22-alpine AS builder
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
ENV VITE_BUILD_SHA=$GIT_SHA \
    VITE_BUILD_TIME=$GIT_BUILD_TIME
RUN pnpm --filter @bettertrack/web build

# ── runner: nginx front proxy — fronts web/admin/api origins, both modes ─────
FROM nginx:alpine AS runner
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
