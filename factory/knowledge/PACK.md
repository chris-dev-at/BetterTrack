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
as visible "Coming soon" pages. **V1 (core + tiny friend sharing), V2
(multi-portfolio UI, cash balance, PIN lock, 2FA, admin rework, sharing
expansion, notification matrix, personal API keys + OAuth apps) and V3 (i18n
EN/DE, Net Worth & cash sources, AT tax engine + dividends, sharing audiences +
multi-watchlists, friend rows/public profiles/chat, realtime + Live Mode,
analytics deep-dive, price alerts + follows, PWA/web-push/FCM prep,
bettertrack.at go-live) and V4 (registration modes + Google login, mobile
platform enablement, notification UX + deep links, admin controls + 2FA,
announcements + health page, account export + offsite backup, custom benchmarks
+ scheduled rebalancing, broker CSV imports, Ideas, Telegram/Discord channels)
are SHIPPED. Current milestone: V5 (§13.5, owner-re-confirmed 2026-07-17)** —
the v4-feedback P0 family (login layout, channel deactivation, profile icons,
permission declutter, Connections hub), perf & scale (snapshots/ETag/failover),
zero-setup observability + admin Problems page, digest + quiet hours, tax DE +
custom tax builder, market intelligence (dividends/earnings/news — deep),
workboard endgame, Forecast + standing orders + calculators, MIRRORCHAIN group
portfolios, social comments/reactions/groups ("simple but powerful"), expense
tracking, webhooks + key governance, local-Ollama AI + pluggable providers,
privacy modes (discreet + client-encrypted paranoid incl. user Drive), the
mobile-usable webapp (iOS-first + PWA polish), admin session policy.
**Global anti-bloat rule (owner): main things immediately visible; niche
sub-features fold away compact — no surface may make the app FEEL more bloated.**

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
(Socket.IO) **shipped in V3-P7**: authed gateway bridged to the event bus, with
TanStack Query poll refetch as the permanent fallback.

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
  code is the most-tested; changes there need thorough unit tests. Factory agents
  test per touched package (`pnpm --filter <pkg> test`), never the root suite (CI
  runs it on the PR); e2e (Playwright) runs in the nightly workflow, not PR CI.
- **Git / factory flow:** the factory works on branch **`task/<N>`** off `main`,
  one issue per run. Run `pnpm format` before every commit — unformatted files are
  the factory's most common CI failure (`format:check` gates the PR). PR body must
  contain **`Closes #<N>`**, a summary, and real
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

## V5 phases (PROJECTPLAN §13.5) — one line each, "done when" essence

V1–V4 are fully shipped. The earliest §13.5 phase whose acceptance criteria the
code doesn't meet is the current phase; disjoint arcs run in parallel via
`mf-meta` claims. Binding rules unchanged (S-items only in surface bundles; every
user-facing string ships EN + DE i18n keys — hardcoded string = blocking review
finding; privacy friction ladder on audience controls) **plus the anti-bloat
rule above, binding on every new surface.** Design-note-first phases (P7
mirrorchain, P13 paranoid) get their §16 design note merged BEFORE feature code.
Owner-provided items (env-gated, never block): Ollama endpoint/model (P12);
per-user Drive consents are end-user OAuth, not owner setup.

- **V5-P0 — v4-feedback quick wins (S/M bundle, diff:normal):** login layout
  final (Google top; sign-up box back at the BOTTOM with the OR divider;
  register page gets the mirrored "Have an account? → Sign in" box);
  **Telegram + Discord deactivated** via a global default-OFF switch (code/
  schema/rows stay; columns+settings hidden, endpoints refuse; env flip
  restores); curated profile-icon set (finite avatars, picker, rendered on all
  social surfaces; no uploads).
- **V5-P0b — Permission surfaces declutter (M, diff:normal):** scope pickers
  (Settings → API Access, admin OAuth editor, consent screen) become ONE row
  per module with read/write where write⇒read; info-points replace description
  walls; sections collapsed by default.
- **V5-P0c — Connections hub foundation (M/L, diff:intermediate):** new
  Settings → Connections area; the Google identity block MOVES there from
  Security (rules unchanged); source tags on transactions/dividends/cash
  (`manual`/`import:<broker>`/`sync:<provider>`, badge + filter; V4-P8 imports
  adopt theirs); per-asset capability tags ("syncs with Parqet").
- **V5-P1 — Performance & scale (L, diff:hard/max):** daily snapshot table
  (precomputed per-portfolio series; backfill; invalidation rules §16-logged —
  the correctness core; "today" stays fresh); ETag/Last-Modified + 304s on hot
  reads; second quote provider with health-based failover, visible in admin;
  INTRADAY portfolio series so the 1D/1W ranges render a real dense curve
  (≥20 points via intraday quotes + history-stitching), never two closes.
- **V5-P2 — Observability & admin ops (M/L, diff:intermediate):** ZERO owner
  setup, all self-provisioned in the deploy stack; Prometheus + Grafana bound
  to localhost/LAN only; admin = the only public management surface; usage
  analytics in admin (DAU/WAU/MAU, feature counters, funnel — first-party
  only); feature-flag kill-switches read per request; **admin Problems page**
  (errors/failed jobs captured into the DB, PII-scrubbed, status/resolve — the
  Sentry replacement; Sentry itself is rejected, never activate a DSN).
- **V5-P3 — Digest + quiet hours (M, diff:normal/intermediate):** per-user
  per-type instant/daily/weekly digests (one summary per period, matrix-
  honoring); quiet-hours window + timezone with queue-and-deliver-at-end;
  urgent-bypass class planner-defined + §16-logged; settings stay one compact
  block.
- **V5-P4 — Tax: Germany + export + tax v2 (L, diff:max, money):** DE
  (Abgeltungsteuer 25 % + Soli, FIFO — cost-basis strategy becomes pluggable,
  Sparer-Pauschbetrag, separate Aktien/Sonstige loss pots) encoded as fixtures
  BEFORE implementation; per-year CSV + printable PDF export (AT + DE); tax v2:
  the manual mode gains a configurable default prefilled per trade/dividend and
  editable, plus a CUSTOM rule-built mode (rate %, in-year loss offset, refund,
  year reset, carry, cost-basis choice) — AT/DE expressible as parameter sets.
- **V5-P5 — Market intelligence, deep (L, diff:intermediate/hard):** dividend
  calendar (ex/pay dates) + payout history + forward yield + PROJECTED
  portfolio dividend income (feeds P6b); earnings calendar (asset page +
  Workboard + opt-in notification); per-asset news + portfolio news digest;
  splits awareness; all provider-abstracted, env-gated, invisible when
  unconfigured; compact per the anti-bloat rule.
- **V5-P6 — Workboard endgame (L, diff:hard/max engine):** N-way conglomerate
  comparison (generalize the V4-P7 2-series math); nested conglomerates (cycle
  reject, planner-set depth cap, recursive weight resolution); what-if
  sandboxes on shared views (local-only tweaks + "reset to shared").
- **V5-P6b — Forecast + standing orders + calculators (L, diff:hard):**
  standing orders auto-record on schedule (monthly/daily buys, cash add
  "salary", cash deduct "Netflix"; pause/resume; rows source-tagged
  `standing-order`); Forecast tab projects net worth from chooseable factors
  (orders continued, historical avg return, what-if plans, projected
  dividends); calculator suite (compound interest, savings plan, dividend,
  withdrawal plan — parqet.com/de/rechner is the inspiration bar), standalone
  AND prefillable from the real portfolio; tab naming owner-eyed.
- **V5-P7 — MIRRORCHAIN group portfolios (XL, diff:max, privacy + money +
  sync):** one logical portfolio replicated as a synced copy in EVERY member's
  account — appears as one, any member's write propagates to all; exactly one
  transferable OWNER (final say: add/remove members, grant manage rights),
  managers may add/remove too; kicked/leaving members KEEP their copy as an
  un-synced fork; any member's account deletion leaves the chain intact
  (owner-deletion succession per design note); TWR/tax per account; invites =
  friends + friction ladder; replication/conflict/succession design note
  §16-merged BEFORE code; UX mandate: seamless, zero member-side config.
- **V5-P8 — Social: comments, reactions, groups (M/L, diff:intermediate):**
  per-item comment threads (visibility = item audience; delete-own; item-owner
  moderates), emoji reactions, named friend groups as audiences (between
  specific- and all-friends in picker + ladder); NO public comments; "simple
  but powerful" — ground-up redesign of the social surfaces is allowed if that
  is what clarity takes.
- **V5-P9 — Expense tracking (L × ≥3 issues, diff:hard):** NEW top-level area,
  zero portfolio/TWR/tax interaction; bank CSV import on the V4-P8 framework
  (Erste/George, Raiffeisen ELBA, N26, Revolut mappers); rule-based auto-
  categorization with editable rules; category/month dashboards; per-category
  budgets with matrix-routed alerts; portfolio surfaces byte-identical when
  unused.
- **V5-P10 — API platform (M/L, diff:intermediate/hard):** outbound webhooks
  (per-event subscriptions, HMAC-signed, retries + backoff, delivery log,
  auto-disable on persistent failure); admin-configurable per-key rate tiers;
  per-key audit trail (last-used, bounded request log).
- **V5-P11 — CUT** (owner 2026-07-17): light theme, widget builder, kiosk move
  to the redesign (#544) and build in v6. Do not compose.
- **V5-P12 — AI: local Ollama + pluggable providers (L, diff:hard):** default
  provider = owner's LAN Ollama (mid-size ~7–14B quantized instruct model;
  don't max the 16 GB card; 8 GB-VRAM future host must stay viable); admin
  LLM-provider settings switchable without redeploy (Ollama endpoint/model OR
  encrypted API tokens for Claude/OpenAI/Gemini — never logged, never sent to
  the web client); features: AI insights (informational, hard "not financial
  advice" framing) + NL conglomerate builder (always a reviewed draft);
  per-user daily caps; unconfigured ⇒ invisible.
- **V5-P13 — Privacy modes (XL; two arcs):** discreet mode — per-user toggle
  hides EVERY absolute amount app-wide (percentages remain); paranoid mode —
  FULL BUILD: client-side encryption, server/Drive/both/**Drive-only** as
  user-chosen blob media (Drive-only ⇒ zero portfolio bytes server-side), the
  per-user Drive connection ships HERE, valuations/stats compute client-side
  after local decryption, social/sharing absent by design, server alerts stay;
  autonomy-prep seams (client data-home + market-data adapters) so clients can
  one day run server-less; high-usability mandate; design note (blob format/
  versioning/conflicts, key custody, feature-kill list, recovery = lost key ⇒
  lost data) §16-merged BEFORE code.
- **V5-P13b — Mobile-usable webapp, iOS-first (L, diff:intermediate):** full
  responsive pass over EVERY user + admin surface (burger nav, tap targets,
  no clipped controls at 390/360 widths); installable-PWA polish for iOS on
  the #350 foundation (install flow, icons/splash, standalone quirks) — this
  IS the iOS app until the native one exists; phone-viewport checks join the
  gate permanently.
- **V5-P13c — Admin session policy (S/M, diff:normal):** admin = login-2FA
  once, NO step-up re-prompts (#430 rejected+closed); admin sessions expire
  early (6–24 h, configurable) independent of user session rules.
- **V5-P14 — DE sweep, e2e & the v5 gate:** human-eye DE pass; empty/error/
  loading sweep; Playwright: digest delivery, DE tax fixture, mirrorchain
  join/write/kick-fork/transfer, comments/groups, expense import → budget
  alert, webhook delivery, standing-order + forecast, paranoid Drive-only
  round trip, NL builder draft; pre-release top-tier review of the whole v5
  branch; file **check v5**.

After all V5 phases: the composer files one `awaiting-owner` **"check v5"** issue
and pauses feature planning (only bug-fix/hardening allowed) until the owner
responds.

## Commands

```
pnpm typecheck            # tsc --noEmit across all packages (CI gate)
pnpm lint                 # ESLint flat config across the repo
pnpm format               # Prettier REWRITE — run before every commit (CI gates format:check)
pnpm test                 # Vitest, all packages — CI-only; in the factory use --filter
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
