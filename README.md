# BetterTrack

Self-hosted **personal finance and investing workspace**: track multiple
portfolios (including investments that exist nowhere else — your car, house, an
unlisted stock), browse assets through a local search index, build and backtest
**Conglomerates** (your own ETF-style weighted baskets), turn a budget into a
buy list, and share portfolios with friends. Organized around five sections:
**Portfolio | Workboard | Assets | Social | Profile Menu**.

See [`PROJECTPLAN.md`](./PROJECTPLAN.md) (plan v2) for the full product and
architecture specification. This README covers local dev setup and production
deploy.

> **Status:** building toward **V1 = BetterTrack Core + Tiny Friend Sharing**
> (PROJECTPLAN.md §13). Auth, admin, market data/providers, search, workboard
> watchlist, portfolio, and the backtest engine exist; the v2 restructure
> (5-tab navigation, local search index, social, notifications, settings,
> admin app settings, API `/docs`) lands phase by phase. Future surfaces ship
> as visible "Coming soon" pages.

## Repository layout

```
apps/
  web/        # React 19 + Vite + Tailwind 4 SPA (user app + admin app)
  api/        # Express 5 service (business layer) + worker entrypoint
packages/
  contracts/  # Shared zod schemas + types (the API/client keystone)
  config/     # Shared tsconfig, ESLint, Prettier
infra/
  docker-compose.yml         # Production: web + api + worker + db + redis (§4.6)
  docker-compose.dev.yml     # Dev: Postgres 17 + Redis 7 only
  nginx/                     # nginx front-proxy: mode templates (subdomains|ports) + entrypoint (§11)
  .env.example               # Dev env template
  .env.production.example    # Production env template
factory/      # autonomous build factory (runner + prompts)
docs/         # auxiliary docs (§4.2) — STARTAUTOMATE.md (factory runbook) and
              # FableBackExecute.md (outage-runbook template)
```

## Prerequisites

- **Node.js 22+**
- **pnpm** via Corepack (no global install needed): `corepack enable`
- **Docker** (for the dev database/cache)

The pinned pnpm version lives in the root `package.json` `packageManager`
field, so Corepack uses the right one automatically.

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start the dev data layer (Postgres 17 + Redis 7)
pnpm dev:infra            # docker compose -f infra/docker-compose.dev.yml up -d

# 3. (optional) copy env defaults
cp infra/.env.example apps/api/.env
```

## Running

```bash
pnpm dev                  # runs web (Vite) + api (tsx watch) together
# web → http://localhost:5173   (proxies /api → http://localhost:3000)
# api → http://localhost:3000

curl http://localhost:3000/api/v1/health
# {"status":"ok","service":"bettertrack-api","version":"0.1.0",...}
```

Run an app individually with pnpm filters:

```bash
pnpm --filter @bettertrack/api dev
pnpm --filter @bettertrack/web dev
```

## Email (SMTP)

Account emails — invites, temporary passwords, and the welcome message — go out
over SMTP via Nodemailer (PROJECTPLAN.md §6.10); a **Gmail app password**
(`smtp.gmail.com:465`) is the documented first-class preset, and every send is
recorded in the per-user email log. The channel is **optional**:
with no SMTP config the app boots and every account flow still works, because
the admin gets a copyable temp password / invite URL straight from the API
response. Configure these in `apps/api/.env` to turn it on:

| Variable    | Example                             | Notes                                          |
| ----------- | ----------------------------------- | ---------------------------------------------- |
| `SMTP_HOST` | `smtp.mailgun.org`                  | required to enable the channel                 |
| `SMTP_PORT` | `587`                               | `465` ⇒ implicit TLS, anything else ⇒ STARTTLS |
| `SMTP_USER` | `postmaster@mg.example.at`          | optional (omit for unauthenticated relays)     |
| `SMTP_PASS` | —                                   | optional; never logged or returned by the API  |
| `SMTP_FROM` | `BetterTrack <no-reply@example.at>` | required to enable the channel                 |

The channel is enabled only when both `SMTP_HOST` and `SMTP_FROM` are set. Send
failures never roll back account creation/reset/invite state — they are logged
and written to the audit log as `email.send_failed` with a coarse error code,
no secrets.

## Production deploy

The production topology runs five containers (nginx, api, worker placeholder, Postgres 17, Redis 7)
via `infra/docker-compose.yml` — see PROJECTPLAN.md §4.6 for the full spec.

### Prerequisites

- Docker with Compose v2 (`docker compose version`)
- A reverse proxy (Caddy, Traefik, Cloudflare Tunnel) terminating TLS in front of the compose stack.
  Production cookies are `Secure`, so the app **requires an HTTPS origin** — do not expose port 80 to end users directly.

### First-time setup

```bash
# 1. Copy and fill in the production env file
cp infra/.env.production.example infra/.env
$EDITOR infra/.env          # set POSTGRES_PASSWORD, SESSION_SECRET, BT_MODE, BT_DOMAIN

# 2. Build all images
docker compose -f infra/docker-compose.yml build

# 3. Run database migrations
docker compose -f infra/docker-compose.yml run --rm api node dist/scripts/migrate.js

# 4. Seed the first admin account (first-boot only; safe to re-run — no-op if admin exists)
docker compose -f infra/docker-compose.yml run --rm api node dist/scripts/seed.js

# 5. Start all services in the background
docker compose -f infra/docker-compose.yml up -d
```

### Day-to-day commands

```bash
# From the infra/ directory (omit -f flag):
cd infra

docker compose up -d          # start all services
docker compose down           # stop (data volumes preserved)
docker compose logs -f api    # follow API logs
docker compose ps             # check service health

# Deploy an update:
docker compose build          # rebuild images from updated source
docker compose run --rm api node dist/scripts/migrate.js   # apply new migrations
docker compose up -d          # rolling restart
```

### Environment variables

| Variable                  | Required | Notes                                                                             |
| ------------------------- | -------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`            | yes      | Must use `db` hostname (e.g. `postgres://bt:pw@db:5432/bettertrack`)              |
| `POSTGRES_PASSWORD`       | yes      | Password for the `db` service and `DATABASE_URL`                                  |
| `REDIS_URL`               | yes      | `redis://redis:6379`                                                              |
| `SESSION_SECRET`          | yes      | 64 random hex bytes (`openssl rand -hex 64`); comma-separate for rotation         |
| `BT_MODE`                 | no       | `subdomains` (default) or `ports` — picks the deployment topology (§4.6, §11)     |
| `BT_DOMAIN`               | yes      | Base domain/host (`track.example.at`); origins are derived from it                |
| `BT_TLS`                  | no       | Force the derived scheme; blank = per-mode default (subdomains https, ports http) |
| `BT_SUB_API/WEB/ADMIN`    | no       | Subdomain labels in subdomains mode (default `api`/`web`/`admin`)                 |
| `BT_PORT_API/WEB/ADMIN`   | no       | Public service ports in ports mode (default `3000`/`8080`/`8081`)                 |
| `BT_HTTP_PORT`            | no       | Host port the front proxy binds in subdomains mode (default `80`; TLS in front)   |
| `BT_API/WEB/ADMIN_ORIGIN` | no       | Explicit origin overrides — win over derivation (`APP_ORIGIN` = legacy web alias) |
| `SMTP_HOST/FROM`          | no       | Both required to enable email; app runs without them (Gmail preset in `.env`)     |
| `ADMIN_EMAIL/PASSWORD`    | no       | Used once by the seed command; no-op thereafter                                   |

> **Deployment topology (§4.6, §11):** one env scheme drives every public origin,
> and the CORS allowlist + session-cookie attributes are **derived** from it —
> never hand-maintained. `subdomains` fronts `api.` / `web.` / `admin.` of
> `BT_DOMAIN` behind a TLS proxy; `ports` puts each service on its own port of a
> single host. The API validates & derives the origins in `apps/api/src/config/env.ts`;
> the one web image renders the matching nginx layout from `infra/nginx/templates/`
> and injects a per-origin `window.__BT__` (`config.js`) at container start. See
> `infra/.env.production.example` for a fully commented both-modes template.

### Worker (BullMQ)

The worker service is commented out in `infra/docker-compose.yml` — it will be uncommented in Phase 1
when `apps/api/src/worker.ts` is implemented. The compose comment block shows the exact config.

## Quality gates

These are exactly what CI runs (`.github/workflows/ci.yml`):

```bash
pnpm typecheck            # tsc --noEmit across all packages
pnpm lint                 # ESLint (flat config) across the repo
pnpm format:check         # Prettier
pnpm test                 # Vitest unit/wiring tests (PGlite + ioredis-mock, no Docker)
pnpm build                # contracts (tsc) + api (tsup) + web (vite)
```

`pnpm format` rewrites files in place.

## Testing modes

The API test suite has two modes, selected by environment variables:

### Fast default — PGlite + ioredis-mock (no Docker)

```bash
pnpm test                              # from repo root
pnpm --filter @bettertrack/api test    # api only
```

Each test gets a fresh in-process PGlite database and an ioredis-mock instance.
No Docker, no network, runs in seconds. This is the local development default.

### Integration — real postgres:17 + redis:7

```bash
# Requires a running Postgres 17 and Redis 7 (e.g. via pnpm dev:infra)
TEST_DATABASE_URL=postgres://bt:bt@localhost:5432/bettertrack_test \
TEST_REDIS_URL=redis://localhost:6379 \
pnpm --filter @bettertrack/api test:integration
```

Runs a focused slice of the suite (auth, admin, workboard, password) against
real service containers. Drizzle migrations are applied automatically on first
run; each `beforeEach` truncates all tables for isolation. This mode runs in CI
as the `integration` job in `.github/workflows/ci.yml`.

| Variable            | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `TEST_DATABASE_URL` | PostgreSQL connection string; switches the harness to postgres-js |
| `TEST_REDIS_URL`    | Redis URL; switches the harness to real ioredis                   |

Both variables must be set together — the fast default is used for any variable
that is absent.

## How the layers stay in sync

Every request/response body is a zod schema defined once in
`packages/contracts`. The API validates against it and clients derive their
types from it, so the API and its clients cannot silently drift apart. The
health endpoint already demonstrates the full path:
`contracts.healthResponseSchema` → validated in the API route → asserted in the
API test.
