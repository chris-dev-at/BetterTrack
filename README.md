# BetterTrack

Self-hosted web app for watching stocks, building **Conglomerates** (your own
ETF-style weighted baskets), and tracking a real **Portfolio** — including
investments that exist nowhere else (your car, house, an unlisted stock).

See [`PROJECTPLAN.md`](./PROJECTPLAN.md) for the full product and architecture
specification. This README covers local setup only.

> **Status:** P0 foundation bootstrap. The monorepo, shared contracts, a health
> endpoint, and the web placeholder shell are in place. Product features (auth,
> market data, portfolio, conglomerates, alerts) arrive in later phases.

## Repository layout

```
apps/
  web/        # React 19 + Vite + Tailwind 4 SPA (display layer)
  api/        # Express 5 service (business layer) — GET /api/v1/health
packages/
  contracts/  # Shared zod schemas + types (the API/client keystone)
  config/     # Shared tsconfig, ESLint, Prettier
infra/
  docker-compose.dev.yml   # Postgres 17 + Redis 7 for local dev
  .env.example
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
over SMTP via Nodemailer (PROJECTPLAN.md §6.11). The channel is **optional**:
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

## Quality gates

These are exactly what CI runs (`.github/workflows/ci.yml`):

```bash
pnpm typecheck            # tsc --noEmit across all packages
pnpm lint                 # ESLint (flat config) across the repo
pnpm format:check         # Prettier
pnpm test                 # Vitest unit/wiring tests
pnpm build                # contracts (tsc) + api (tsup) + web (vite)
```

`pnpm format` rewrites files in place.

## How the layers stay in sync

Every request/response body is a zod schema defined once in
`packages/contracts`. The API validates against it and clients derive their
types from it, so the API and its clients cannot silently drift apart. The
health endpoint already demonstrates the full path:
`contracts.healthResponseSchema` → validated in the API route → asserted in the
API test.
