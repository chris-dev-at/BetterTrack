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
  docker-compose.yml            # Production: web + api + worker + db + redis (§4.6)
  docker-compose.subdomains.yml # Port overlay for BT_MODE=subdomains — layer via -f or override.yml
  docker-compose.ports.yml      # Port overlay for BT_MODE=ports — layer via -f or override.yml
  docker-compose.dev.yml        # Dev: Postgres 17 + Redis 7 only
  nginx/                     # nginx front-proxy: mode templates (subdomains|ports) + entrypoint (§11)
  backup/                    # backup.sh — nightly pg_dump + rotation, run inside `db` via host cron (§10)
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

Account emails — invites, temporary passwords, the welcome message — plus the
social notification emails (friend request / accepted, portfolio shared) go out
over SMTP via Nodemailer (PROJECTPLAN.md §6.10); a **Gmail app password**
(`smtp.gmail.com:465`) is the documented first-class preset, and every send
attempt is recorded in the email log. The channel is **optional**:
with no SMTP config the app boots and every account flow still works, because
the admin gets a copyable temp password / invite URL straight from the API
response. Configure these in `apps/api/.env` to turn it on:

| Variable    | Example (Gmail preset)        | Notes                                          |
| ----------- | ----------------------------- | ---------------------------------------------- |
| `SMTP_HOST` | `smtp.gmail.com`              | required to enable the channel                 |
| `SMTP_PORT` | `465`                         | `465` ⇒ implicit TLS, anything else ⇒ STARTTLS |
| `SMTP_USER` | `you@gmail.com`               | your Gmail address (omit for unauth relays)    |
| `SMTP_PASS` | your 16-char **app password** | never logged or returned by the API            |
| `SMTP_FROM` | `BetterTrack <you@gmail.com>` | required to enable the channel                 |

The channel is enabled only when both `SMTP_HOST` and `SMTP_FROM` are set. Send
failures never roll back account creation/reset/invite state — they are logged
and written to the audit log as `email.send_failed` with a coarse error code,
no secrets. Every attempt (whether `sent`, `failed`, or — when SMTP is
unconfigured — `suppressed`) is written to an **email log**, viewable in the
admin console globally (Email page) and per user (Users → Emails); rows store
recipient, template, subject, status and a coarse error code only — never a
body or secret.

## Production deploy

The production topology runs five containers (nginx, api, worker, Postgres 17, Redis 7)
via `infra/docker-compose.yml` — see PROJECTPLAN.md §4.6 for the full spec. `docker compose up -d`
starts all five, including the BullMQ **worker** (`node dist/scripts/worker.js`) that runs the
background jobs (§9): nightly quote refresh, on-demand backfill, hourly FX spot refresh, catalog
enrichment for search misses, and notification/email dispatch.

### Prerequisites

- Docker with Compose v2 (`docker compose version`)
- TLS is **strongly recommended** in production. `subdomains` mode expects a reverse proxy
  (Caddy, Traefik, Cloudflare Tunnel) terminating TLS in front of the compose stack; the session
  cookie is `Secure` whenever the derived API origin is `https://`. Plain-HTTP `ports` mode is
  supported by design (`apps/api/src/config/env.ts`) — the session cookie is **not** `Secure`
  over `http`, so treat it as a lower-security option, not the production default.

### First-time setup

```bash
# 1. Copy and fill in the production env file
cp infra/.env.production.example infra/.env
$EDITOR infra/.env          # set POSTGRES_PASSWORD, SESSION_SECRET, BT_MODE, BT_DOMAIN

# 2. Copy the port overlay matching your topology mode (§4.6) to docker-compose.override.yml
#    so plain `docker compose` commands run from infra/ pick it up automatically:
cp infra/docker-compose.subdomains.yml infra/docker-compose.override.yml   # or docker-compose.ports.yml

# 3. Build all images
docker compose -f infra/docker-compose.yml build

# 4. Run database migrations
docker compose -f infra/docker-compose.yml run --rm api node dist/scripts/migrate.js

# 5. Seed the first admin account (first-boot only; safe to re-run — no-op if admin exists)
docker compose -f infra/docker-compose.yml run --rm api node dist/scripts/seed.js

# 6. Start all services in the background — the override file publishes only
#    the host ports your mode needs (no port 80 bound in ports mode)
docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml up -d
```

### Worked example — Mode A: subdomains

Starting from a fresh server with a domain (`track.example.at`) and a TLS-terminating
front proxy (Caddy/Traefik/Cloudflare Tunnel) already pointed at it:

1. Create three DNS records, all pointing at the server: `api.track.example.at`,
   `web.track.example.at`, `admin.track.example.at`.
2. Point your TLS proxy at this compose stack's `web` service, port 80
   (`BT_HTTP_PORT`, default `80`) — it's a plain HTTP origin behind the proxy.
3. `infra/.env`:
   ```
   BT_MODE=subdomains
   BT_DOMAIN=track.example.at
   BT_HTTP_PORT=80
   POSTGRES_PASSWORD=<strong password>
   DATABASE_URL=postgres://bt:<strong password>@db:5432/bettertrack
   SESSION_SECRET=<openssl rand -hex 64>
   ```
4. Run the **First-time setup** steps above, using `docker-compose.subdomains.yml`
   as the override in steps 2 and 6 — it publishes only `BT_HTTP_PORT` (default `80`).
5. Verify: `https://api.track.example.at/api/v1/health`, `https://web.track.example.at`,
   `https://admin.track.example.at` all resolve through the proxy.

### Worked example — Mode B: ports

Starting from a fresh server with only a bare IP or hostname, no subdomains, no
front proxy — every service is exposed on its own port:

1. `infra/.env`:
   ```
   BT_MODE=ports
   BT_DOMAIN=203.0.113.10   # or a hostname
   BT_TLS=false
   BT_PORT_API=3000
   BT_PORT_WEB=8080
   BT_PORT_ADMIN=8081
   POSTGRES_PASSWORD=<strong password>
   DATABASE_URL=postgres://bt:<strong password>@db:5432/bettertrack
   SESSION_SECRET=<openssl rand -hex 64>
   ```
2. Open (or forward) ports `3000`, `8080`, `8081` on the host firewall.
3. Run the **First-time setup** steps above, using `docker-compose.ports.yml` as
   the override in steps 2 and 6 — it publishes `BT_PORT_API/WEB/ADMIN` only,
   nothing binds port 80, so this is safe on a host already serving something
   else there.
4. Verify: `http://203.0.113.10:3000/api/v1/health`, `http://203.0.113.10:8080`,
   `http://203.0.113.10:8081` are all reachable directly, no proxy required.
   Put a TLS-terminating proxy in front and set `BT_TLS=true` once you're ready
   for HTTPS — cookies become `Secure` and require it.

### Day-to-day commands

```bash
# From the infra/ directory (omit -f flag — docker-compose.override.yml from
# First-time setup step 2 is picked up automatically):
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

| Variable                      | Required | Notes                                                                                       |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | yes      | Must use `db` hostname (e.g. `postgres://bt:pw@db:5432/bettertrack`)                        |
| `POSTGRES_PASSWORD`           | yes      | Password for the `db` service and `DATABASE_URL`                                            |
| `REDIS_URL`                   | yes      | `redis://redis:6379`                                                                        |
| `SESSION_SECRET`              | yes      | 64 random hex bytes (`openssl rand -hex 64`); comma-separate for rotation                   |
| `BT_MODE`                     | no       | `subdomains` (default) or `ports` — picks the deployment topology (§4.6, §11)               |
| `BT_DOMAIN`                   | yes      | Base domain/host (`track.example.at`); origins are derived from it                          |
| `BT_TLS`                      | no       | Force the derived scheme; blank = per-mode default (subdomains https, ports http)           |
| `BT_SUB_API/WEB/ADMIN`        | no       | Subdomain labels in subdomains mode (default `api`/`web`/`admin`)                           |
| `BT_PORT_API/WEB/ADMIN`       | no       | Public service ports in ports mode (default `3000`/`8080`/`8081`)                           |
| `BT_HTTP_PORT`                | no       | Host port the front proxy binds in subdomains mode (default `80`; TLS in front)             |
| `BT_API/WEB/ADMIN_ORIGIN`     | no       | Explicit origin overrides — win over derivation (`APP_ORIGIN` = legacy web alias)           |
| `SMTP_HOST/FROM`              | no       | Both required to enable email; app runs without them (Gmail preset in `.env`)               |
| `ADMIN_EMAIL/PASSWORD`        | yes\*    | \*Required for `seed.js` (hard-exits without both, see `scripts/seed.ts`); no-op thereafter |
| `BACKUP_RETENTION_DAYS`       | no       | Days of nightly dumps to keep in the `pgbackups` volume (default `14`)                      |
| `RATE_LIMIT_BURST_WINDOW_SEC` | no       | Short burst window for the general API limiter, seconds (default `10`, §10)                 |
| `RATE_LIMIT_BURST_LIMIT`      | no       | Requests allowed per burst window before it trips the escalation ladder (default `60`)      |

> **Deployment topology (§4.6, §11):** one env scheme drives every public origin,
> and the CORS allowlist + session-cookie attributes are **derived** from it —
> never hand-maintained. `subdomains` fronts `api.` / `web.` / `admin.` of
> `BT_DOMAIN` behind a TLS proxy; `ports` puts each service on its own port of a
> single host. The API validates & derives the origins in `apps/api/src/config/env.ts`;
> the one web image renders the matching nginx layout from `infra/nginx/templates/`
> and injects a per-origin `window.__BT__` (`config.js`) at container start. See
> `infra/.env.production.example` for a fully commented both-modes template.

### Worker (BullMQ)

The `worker` service in `infra/docker-compose.yml` is the fifth production container, built from the
same `apps/api/Dockerfile` image as the api and started by `docker compose up -d` (command
`node dist/scripts/worker.js`). It carries the same environment as the api and depends on healthy
`db` + `redis` (it needs Postgres and Redis, not the api HTTP service), and publishes no host ports.
It runs the scheduled and event-driven jobs (§9): `prices.refreshDaily` (nightly closes),
`prices.backfill` (on-demand history), `fx.refreshSpot` (hourly FX), `catalog.enrich` (search-miss
enrichment), and `notifications.dispatch` (friend request/accept/share email + notification fan-out).

### Backups & restore

The `db` service mounts a dedicated `pgbackups` volume at `/backups` and
`infra/backup/backup.sh` is bind-mounted read-only into that same container at
`/opt/bettertrack/backup.sh`. Nothing runs it automatically — wire it to your
host's cron (kept out of the compose topology so the stack stays at five
services, §4.6):

```bash
# Host crontab (crontab -e) — nightly at 03:00 server time:
0 3 * * * cd /path/to/bettertrack/infra && docker compose exec -T db bash /opt/bettertrack/backup.sh >> /var/log/bettertrack-backup.log 2>&1
```

Each run writes a gzip'd, timestamped dump (`bettertrack-YYYYmmdd-HHMMSS.sql.gz`)
into the `pgbackups` volume, verifies the archive (`gzip -t`), then deletes
dumps older than `BACKUP_RETENTION_DAYS` (default 14). Take a manual backup the
same way, on demand:

```bash
cd infra
docker compose exec -T db bash /opt/bettertrack/backup.sh
docker compose exec db ls -la /backups
```

**Restore from a dump:**

```bash
cd infra

# 1. Pick a dump (lists everything currently retained).
docker compose exec db ls -la /backups

# 2. Stop the api and worker so nothing writes during restore.
docker compose stop api worker

# 3. Restore — the dump was taken with --clean --if-exists, so it drops and
#    recreates every object itself; safe to run against the existing database.
docker compose exec -T db bash -c \
  'gunzip -c /backups/bettertrack-20260704-030000.sql.gz | psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# 4. Bring the api and worker back up.
docker compose start api worker
```

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

### End-to-end — Playwright happy path (nightly, not per-commit)

```bash
pnpm exec playwright install --with-deps chromium   # one-time browser install
pnpm dev:infra                                       # Postgres + Redis
pnpm test:e2e
```

One spec (`e2e/happy-path.spec.ts`) drives the real app in two browser
contexts: invite → login → local search → watch → build a conglomerate →
allocate → add to portfolio → enable friend sharing → a second account
accepts the request and sees the shared portfolio — extended with the V2
flows (§13.2 V2-P11): a 1-char ticker search watched from the asset detail
page (appearing on the watchlist with no manual reload), a cash-funded buy
(deposit → pay-from-cash preview → reconciled cash line), creating and
switching to a second portfolio, and sharing a watchlist to a friend who sees
it read-only under Shared With Me. `playwright.config.ts` boots the real
api + web dev servers (migrating and seeding the api's database first)
against whatever `E2E_DATABASE_URL`/`E2E_REDIS_URL` point at (defaults match
`pnpm dev:infra`). It runs against two Playwright projects — `chromium`
(`Desktop Chrome`) and `mobile-chromium` (`Pixel 7`, 412×839) — so the happy
path is proven on a phone-width viewport as well as desktop. This is **not**
part of `pnpm test` or the per-commit CI gate — it runs nightly via
`.github/workflows/e2e-nightly.yml` (also triggerable manually).

## How the layers stay in sync

Every request/response body is a zod schema defined once in
`packages/contracts`. The API validates against it and clients derive their
types from it, so the API and its clients cannot silently drift apart. The
health endpoint already demonstrates the full path:
`contracts.healthResponseSchema` → validated in the API route → asserted in the
API test.
