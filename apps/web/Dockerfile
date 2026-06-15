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
RUN pnpm --filter @bettertrack/web build

# ── runner: nginx serving the SPA + proxying /api ───────────────────────────
FROM nginx:alpine AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
# nginx.conf is at infra/nginx.conf relative to the repo root (build context)
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
