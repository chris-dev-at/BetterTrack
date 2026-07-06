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
as visible "Coming soon" pages. **V1 (core + tiny friend sharing) and V2
(multi-portfolio UI, cash balance, PIN lock, 2FA, admin rework, sharing
expansion, notification matrix, personal API keys + OAuth apps) are SHIPPED.
Current milestone: V3 (§13.3)** — Net Worth & cash sources, tax engine (AT),
analytics deep-dive, sharing audiences everywhere + multiple watchlists, friend
rows/public profiles/chat, realtime + Live Mode, price alerts, late-listing
backtest modes, i18n EN/DE, PWA + web-push + FCM prep, bettertrack.at go-live
surfaces.

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
(Socket.IO) is designed-for and **lands in V3-P7** — until that merges, surfaces
rely on TanStack Query refetch (which stays as the fallback afterwards).

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
  NOT autopilot) · exactly one difficulty label
  (`diff:easy|diff:normal|diff:intermediate|diff:hard|diff:max`); legacy `tier:*`
  labels still resolve (sonnet→easy, opus→intermediate, fable→max).

## Difficulty routing (digest of MODELUSE.md + docs/multi-factory.md)

Every issue gets exactly one `diff:*` label; `state/control/models.json`
(dashboard Models tab) resolves each difficulty to a provider/model/effort —
defaults are all-Claude. When unsure, take the higher difficulty. Escalate
instead of looping: a bug surviving two fix attempts moves up one difficulty.

- **diff:max / diff:hard** (old T1 Fable) — correctness-critical / architectural
  keystones: everything under `apps/api/src/domain/**` (holdings, backtest,
  allocation, the V3 realized-P/L + tax engine, alert evaluator), the provider
  **caching/coalescing/serve-stale/currency** keystone (§5.3), the **local
  search-index core** (§6.2), and plan-deviation design decisions.
- **diff:intermediate** (old T2 Opus) — security & subtlety: auth/sessions/PIN/
  rate-limiting, account kinds, admin routes, registration modes (§6.12),
  friendship/sharing **privacy boundaries** (§6.9 and the V3-P5 audience model),
  tokens, import/export, DB schema/migrations, BullMQ jobs, realtime/event bus,
  the **Builder** UI, deployment-topology config (§11), design-polish pass.
  The security floor never drops below this.
- **diff:easy / diff:normal** (old T3 Sonnet floor) — CRUD, plain UI pages,
  Coming-Soon placeholders, config/CI/compose, templates, e2e, docs, i18n string
  sweeps.

## V3 phases (PROJECTPLAN §13.3) — one line each, "done when" essence

V1 (§13) and V2 (§13.2) are fully shipped. The earliest §13.3 phase whose
acceptance criteria the code doesn't meet is the current phase; disjoint arcs run
in parallel via `mf-meta` claims. Binding rules: S-items only in surface bundles
(3–6 items, one surface, one difficulty); **after V3-P1 every PR ships its
user-facing strings through i18n with EN + DE keys** (hardcoded string = blocking
review finding); audience controls carry the privacy friction ladder (strong
warning on public / light confirm on all-friends / none on specific friends).

- **V3-P0 — v2-feedback quick wins (S bundle, diff:normal):** portfolio-selection
  reset BUG (Transactions/Custom-Assets nav reverts to default — regression
  test); "Total Value"→"Net Worth" app-wide (grep gate); liquidity bar →
  integrated redesign; calculator stepper → decimal precision (1/0.1/0.01/0.001).
- **V3-P1 — i18n foundation (L, diff:intermediate):** EN source-of-truth + DE
  first translation; per-user language picker in Settings; all strings extracted;
  locale-aware dates/numbers; localized emails; a new language = one locale file
  - registry entry (zero code); CI gate on hardcoded strings.
- **V3-P2 — Custom assets v2 (M, diff:intermediate):** real category on custom
  assets (catalog taxonomy — the CUSTOM slice dies; migration → `other` +
  re-categorize banner); per-asset value-smoothing toggle (linear between marks,
  mark-day values stay exact).
- **V3-P3 — Cash sources (L, diff:max):** V2 cash ledger becomes **Main** + named
  sources (bank/retirement/cash/custom), each with balance + history; atomic
  paired transfers; source picker on deposit/withdraw/buy/sell; Net Worth +
  liquidity roll-up; internal transfers are NEVER TWR external flows.
- **V3-P4 — Realized P/L, tax, dividends (L, diff:max; needs P3):**
  moving-average cost basis; per-calendar-year realized P/L; tax modes None /
  Manual-per-trade / Country-specific (AT only: 27.5 % on gains + dividends,
  same-year loss offset with refund, hard Jan-1 reset, NO cross-year carry);
  dividend transactions land in a chosen cash source; per-year P/L + dividends +
  taxes report. Owner's required test: +450 € taxed, then −100 € loss ⇒ year
  total tax = 27.5 % × 350 €.
- **V3-P5 — Sharing audiences (L, diff:intermediate):** ONE picker + enforcement
  layer for EVERY portfolio/conglomerate/watchlist — private / specific friends /
  all friends / public link (≥128-bit, revocable); friction ladder lives in the
  picker; multiple named watchlists (General default) with per-list audience;
  V2-P9-grade privacy tests per kind × audience.
- **V3-P6 — Friend rows + public profiles (M/L, diff:intermediate; needs P5):**
  friend rows expand in place (their shares to me by kind + my shares to them +
  actions; kind counts collapsed); opt-in public profile (slug URL) composing
  public items, strong warning, instant unpublish.
- **V3-P7 — Realtime + Live Mode (L, diff:hard):** authed WebSocket bridged to
  the event bus (bell/quote push, poll fallback, flagged rollout); Live Mode per
  §6.3 (shared poll loop → Redis ring → `asset:{id}` fan-out, 1 m–12 h,
  auto-stop).
- **V3-P8 — Friend chat (L, diff:intermediate; needs P7a):** 1:1 DMs, unread
  badges, realtime + poll fallback, `chat.message` in the notification matrix;
  share-in-chat chips NEVER widen access.
- **V3-P9 — Analytics page (L, diff:hard; needs P2):** Portfolio → Analytics:
  per-asset hide/show, category/type filters, free ranges, value/perf-% modes,
  contribution table; overlay-assets mode MOVES here from the overview; compare
  vs index/asset/other portfolio/conglomerate with side-by-side stats (total %,
  CAGR, max drawdown); inflation real-terms mode (HICP/CPI/custom flat rate).
- **V3-P10 — Backtest modes, alerts, market data (4 disjoint arcs):**
  late-listing modes clip/cash-until-listing/redistribute + entry markers +
  entry-day rebalance primitive (diff:max); §14 price-alert spec verbatim with
  minute evaluator + idempotency (diff:intermediate); gold + crypto symbols
  (diff:easy); per-user base currency through the §5.3 core (diff:hard).
- **V3-P11 — Platform & security (M/L, diff:intermediate):** session manager
  (list + revoke one/all-others); PWA (manifest/SW/offline shell) + web-push
  channel (VAPID, opt-in from settings only, matrix column); FCM prep:
  `device_tokens` + authed register endpoints + env-gated FCM channel
  (server-only — the phone app is a separate future project).
- **V3-P12 — bettertrack.at surfaces (M, diff:normal):** static product landing
  page (root origin, own tiny compose site); `mobile.` placeholder page;
  5-origin topology config (product/web/admin/api/mobile) behind Cloudflare +
  always-on-Mac deploy guide.
- **V3-P13 — DE sweep, polish, e2e, v3 gate:** human-eye DE pass (du-Form,
  consistent finance vocabulary); empty/error-state + responsive sweeps;
  Playwright extended (cash transfer, AT-tax sell w/ refund, analytics compare,
  share-to-one-friend, second watchlist, chat, alert fire); pre-release Fable
  review; file **check v3**.

After all V3-P0…P13: the composer files one `awaiting-owner` **"check v3"** issue
and pauses feature planning (only bug-fix/hardening allowed) until the owner
responds.

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
