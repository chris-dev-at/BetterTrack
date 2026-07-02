# BetterTrack — Factory Knowledge Pack

Standing brief for factory agents (planner/writer/reviewer/fixer). This pack is
injected into every prompt to replace cold-start orientation. It supersedes
PROJECTPLAN.md / MODELUSE.md / CLAUDE.md for orientation — do not re-read those to
get your bearings (see "How to orient" at the end).

## What BetterTrack is

Self-hosted personal finance & investing workspace (single-owner, closed by
default). Track multiple portfolios — including off-market assets (car, house, an
unlisted stock) — browse assets via a local search index, build & backtest
**Conglomerates** (user-defined ETF-style weighted baskets), turn a budget into a
buy list, and share portfolios with friends. Five-tab product:
**Portfolio | Workboard | Assets | Social | Profile Menu**. Future surfaces ship
as visible "Coming soon" pages. **V1 = BetterTrack Core + Tiny Friend Sharing.**

## Architecture

pnpm monorepo (`pnpm@9.15.9`, Node ≥22), TypeScript end-to-end. Three strictly
separated layers: **display → business → (domain + data + providers)**; deps never
flow backward, and `domain/` imports nothing but types.

- **apps/web** — React 19 + Vite 6 + Tailwind 4 + react-router 7 SPA (user app +
  admin app). Data via TanStack Query + a typed API client. Charts:
  `lightweight-charts` + Recharts. Source split: `src/user/**`, `src/admin/**`,
  `src/ui/**` (reusable), `src/lib/**` (apiClient, cx, adminApi).
- **apps/api** — Express 5 service (+ BullMQ worker entrypoint). Internal layout
  under `apps/api/src/`: `http/routes` + `http/middleware` (thin: parse → service
  → respond) · `services/**` (business orchestration, one dir per module) ·
  `domain/**` (pure money-math: holdings, backtest; allocation coming) ·
  `data/**` (Drizzle schema + repositories — all SQL lives here) ·
  `providers/**` (AssetProvider interface, registry, yahoo, cache/coalescing/
  circuit-breaker) · `jobs/**` (BullMQ queues/processors/cron) · `events/**`
  (typed domain event bus) · `config/**` (env schema) · `scripts/**`
  (migrate/seed/worker).
- **packages/contracts** — the keystone. Every request/response body is a zod
  schema defined once (`@bettertrack/contracts`); the API validates against it and
  the SPA derives its types from it, so they cannot silently drift. Later feeds
  OpenAPI `/docs`.
- **packages/config** — shared tsconfig base, ESLint flat config, Prettier config.

**Stack specifics:** PostgreSQL 17 via Drizzle ORM (also hosts the search index:
`pg_trgm` + tsvector); Redis 7 = quote cache, BullMQ jobs, session store,
rate-limit state; auth = httpOnly session cookies + argon2id; market data via
`yahoo-finance2` behind the provider interface (cached/coalesced/swappable); email
via Nodemailer/SMTP (Gmail app-password preset, optional); IDs = UUIDv7. Realtime
(Socket.IO) is designed-for but **post-v1** — V1 relies on TanStack Query refetch.

## Conventions

- **Where code lives:** business logic in `services/**`; pure functions with no
  I/O in `domain/**`; all SQL in `data/**` (schema + repositories); HTTP handlers
  stay thin in `http/routes`. New API modules are additive — create dirs as phases
  land, don't move existing files. Contracts (zod) are the single source of truth
  for shapes; add/extend a schema in `packages/contracts` rather than hand-typing.
- **Tests:** Vitest. API tests default to PGlite + ioredis-mock (no Docker, runs
  in seconds); an integration mode uses real Postgres 17 + Redis 7 via
  `TEST_DATABASE_URL`/`TEST_REDIS_URL`. Tests required by an issue land in the same
  change. **Never delete or skip a failing test to get green.** Domain (money-math)
  code is the most-tested; changes there need thorough unit tests.
- **Git / factory flow:** the factory works on branch **`task/<N>`** off `main`,
  one issue per run. PR body must contain **`Closes #<N>`**, a summary, and real
  test output. PRs are **squash-merged** with `--delete-branch`. Commit/PR titles
  are conventional: `feat(scope): …`, `fix(web): …`, `[P<n>] …`. Reviewer posts one
  comment ending in a `FACTORY-VERDICT: APPROVE|REQUEST_CHANGES` line; approve only
  with zero `[blocking]` findings. CI (`.github/workflows/ci.yml`) must be green
  before merge.
- **Labels:** `autopilot` (queued for the factory) · `in-progress` · `needs-human`
  (stuck/ambiguous — factory stops) · `awaiting-owner` (planned, needs owner OK,
  NOT autopilot) · exactly one tier label (`tier:fable|tier:opus|tier:sonnet`).

## Model-tier routing (digest of MODELUSE.md)

Floor is **Sonnet at high effort** — nothing runs below it. When unsure, take the
higher tier. Each issue gets exactly one tier label:

- **tier:fable** (T1, Claude Fable 5) — correctness-critical / architectural
  keystones: everything under `apps/api/src/domain/**` (holdings, backtest,
  allocation; later alertEval), the provider **caching/coalescing/serve-stale/
  currency** keystone (§5.3), the **local search-index core** (§6.2), and
  plan-deviation design decisions. First money-math implementations at `max`.
- **tier:opus** (T2, Claude Opus 4.8) — security & subtlety: auth/sessions/PIN/
  rate-limiting, account kinds, admin routes, registration modes (§6.12),
  friendship/sharing **privacy boundaries** (§6.9), tokens, import/export, DB
  schema/migrations, BullMQ jobs, realtime/event bus, the **Builder** UI,
  deployment-topology config (§11), design-polish pass. Security floor never drops
  below Opus.
- **tier:sonnet** (T3, Claude Sonnet 5, high) — CRUD, plain UI pages, Coming-Soon
  placeholders, config/CI/compose, templates, e2e, docs.

Escalate instead of looping: a bug surviving two fix attempts moves up one tier.

## V1 phases (PROJECTPLAN §13) — one line each, "done when" essence

Order is pragmatic; earliest phase whose acceptance criteria the code doesn't yet
meet is the current phase. Already built: auth, admin, providers/caching v1,
search v1, asset page, workboard watchlist, portfolio, backtest engine, jobs;
P0 v2 app shell (5-tab nav + placeholders) merged.

- **P0 — v2 shell & restructure:** 5-tab nav + profile dropdown + subnavs + route
  tree with ComingSoon placeholders; §7.3 file moves; docs→`docs/`. Done: every
  tab/subnav opens, placeholders say Coming soon, tests green. (merged)
- **P1 — Asset catalog, local search & cache rework:** catalog indexes (tsvector +
  pg_trgm) + seed; local-first `/search` + background `catalog.enrich`; caching
  hardening (coalescing, negative cache, serve-stale, per-provider budgets). Done:
  "bay"/"bayr" → BAYN.DE instantly with zero sync provider calls; concurrent misses
  = one upstream fetch; outage → stale, never errors.
- **P2 — Identity, sessions & topology:** admin/user account-kind split; 30-day
  sessions + PIN; progressive rate limiting; topology env scheme + nginx templates
  (both modes) + runtime SPA config. Done: admin↔user endpoint isolation (test);
  PIN renews window; limiter escalation/decay; boots in subdomains & ports mode.
- **P3 — Portfolio v2 & multi-portfolio prep:** `portfolio_id`-scoped API + one
  auto default; overview blocks (totals, perf chart, holdings, top winners/losers,
  donuts, recent tx, quick add); `visibility` flag (consumed P5). Done: scoped flows
  work; a 2nd portfolio row appears in `GET /portfolios` without code changes.
- **P4 — Workboard: Conglomerates + calculator:** finish conglomerate CRUD +
  **Builder** (locks/auto-balance/normalize/autosave/live preview §6.5) + backtest
  UI; `domain/allocation` never-overshoot algorithm + calculator UI + bulk buy.
  Done: 13/40/47 basket, 5Y backtest vs S&P; 1000 € → buy list ≤ budget.
- **P5 — Social minimal:** `friend_requests` + `friendships`; request by
  username/email (no enumeration), accept/decline/cancel/remove; Friends page;
  `visibility=friends` → Shared With Me + read-only friend view. Done: two-account
  flow; privacy tests (non-friends 404, visibility-off 404, unfriend closes access).
- **P6 — Notifications & email log:** bell + unread + mark-read (REST refetch);
  `notification_settings`; friend.request/accepted + portfolio.shared wired to P5
  events; Gmail SMTP preset; `email_log` per send; admin log views. Done: request →
  bell item + logged email within seconds; SMTP-less deploys log `suppressed`.
- **P7 — Settings section:** subnav — Account (privacy/sharing toggles),
  Notifications, Security (sessions/PIN) implemented; Imports/Connections/Backups/
  API-Access as designed placeholders. Done: every subpage reachable.
- **P8 — Admin global settings & registration modes:** `app_settings` + admin
  Settings page; registration-mode selector (closed enforced; others visible,
  disabled) enforced from day one; overview cards refresh. Done: settings persist +
  audit-log; closed mode blocks a hand-crafted register call; selector shows 4 modes.
- **P9 — API `/docs`:** OpenAPI 3 from contracts; `GET /openapi.json` + `GET /docs`
  on the API origin; CI coverage gate. Done: `/docs` renders complete/accurate
  endpoints; CI fails on an undocumented route.
- **P10 — Polish, e2e & v1 gate:** empty states/skeletons/error boundaries;
  responsive pass; disclaimers; deploy guide (both modes); Playwright e2e;
  pre-release Fable review. Done: fresh invite → stock → conglomerate → buy list →
  friend share on a phone; `docker compose up` works from README in either mode.

After all P0–P10: planner creates one `awaiting-owner` "check v1" issue and pauses
feature planning (only bug-fix/hardening allowed) until the owner responds.

## Commands

```
pnpm typecheck            # tsc --noEmit across all packages (CI gate)
pnpm lint                 # ESLint flat config across the repo
pnpm format:check         # Prettier check (pnpm format rewrites in place)
pnpm test                 # Vitest, all packages (PGlite + ioredis-mock, no Docker)
pnpm build                # contracts (tsc) + api (tsup) + web (vite)
pnpm --filter @bettertrack/api test      # single package's tests
pnpm --filter @bettertrack/web test
pnpm knowledge:build      # regenerate this pack's graph.json + MAP.md
```

## How to orient

Your standing context (this pack + MAP.md + a live STATE block) is injected above
each prompt — trust it. **Do NOT re-read PROJECTPLAN.md / MODELUSE.md / CLAUDE.md
or crawl the tree to orient** — this pack supersedes them for orientation. To
locate files, consult **factory/knowledge/MAP.md** (module map, grouped by dir) and
query **factory/knowledge/graph.json** with `jq`; then read only the files you will
modify or review. Only open a specific PROJECTPLAN section if your issue references
one whose text is not already quoted in the issue body.

Example `jq` queries against `factory/knowledge/graph.json`:

```
# Files that export a given symbol (e.g. "backtest")
jq -r '.nodes[]|select(.exports|index("backtest"))|.path' factory/knowledge/graph.json

# Who imports a module (reverse deps of holdings.ts)
jq -r '.edges[]|select(.to=="apps/api/src/domain/holdings.ts")|.from' factory/knowledge/graph.json

# All files under a dir with their kind + first exports
jq -r '.nodes[]|select(.path|startswith("apps/api/src/services/"))
       |"\(.path) [\(.kind)] \(.exports[0:4]|join(","))"' factory/knowledge/graph.json
```
