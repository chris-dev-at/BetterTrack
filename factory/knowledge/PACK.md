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
bettertrack.at go-live) are SHIPPED. Current milestone: V4 (§13.4)** — the
v3-feedback P0 family, mobile platform enablement (bearer scopes + parity,
idempotency keys, OAuth account chooser, account deletion, FCM go-live),
registration modes + Google login + passkeys, product ops (Sentry, health,
announcements), data export + offsite backup, custom-benchmark + rebalanced
backtests, broker CSV imports, Ideas, Telegram/Discord channels.

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

## V4 phases (PROJECTPLAN §13.4) — one line each, "done when" essence

V1 (§13), V2 (§13.2) and V3 (§13.3) are fully shipped. The earliest §13.4 phase
whose acceptance criteria the code doesn't meet is the current phase; disjoint
arcs run in parallel via `mf-meta` claims. Binding rules: S-items only in surface
bundles (3–6 items, one surface, one difficulty); every PR ships its user-facing
strings through i18n with EN + DE keys (hardcoded string = blocking review
finding); audience controls carry the privacy friction ladder (strong warning on
public / light confirm on all-friends / none on specific friends). Ordering:
**V4-P1…P3 compose and merge before everything except the V4-P0 bundle** (they
block the parallel Android-app track); the P0b/c/d feedback arcs queue after P3.
Owner-provided items are all env-gated and never block: Firebase key (P3), Google
OAuth credentials (P4), Drive/rclone credentials (P6), Telegram bot token (P10).

- **V4-P0 — v3-feedback quick wins (S/M bundle, diff:normal):** PIN entry never
  renders digits (masked dots + lock-screen page-wide key capture); portfolio
  chart ranges add 1D/1W/5Y; FIX inflation presets not deflating (custom % works,
  HICP/CPI presets don't) + show each preset's %/yr; cash-source action icons
  (deposit/withdraw/transfer/set-balance); registration legal-consent notice
  linking the four legal docs; prominent "Sign up" treatment (layout reserves the
  P4 Google button spot); remember-me always on (toggle gone, "stay signed in"
  stays); Social tab: friends top, requests bottom.
- **V4-P0b — Follows rework (M/L, diff:intermediate):** the standalone Following
  page dies; the Friends tab absorbs it — friend-row expansion becomes a
  profile-in-place with shared items, a "News about this person" follow toggle
  and the alert-follow switches; following a FRIEND needs NO public profile
  (server rule change if needed); the alerts/sharing setting gets a Settings
  home; items turning public always notify followers; /following redirects.
- **V4-P0c — Notification UX (M, diff:intermediate):** email defaults OFF for
  every type except the account/security category (new accounts + one-time
  migration, §16-logged); read = archive (+ Archive view); every notification
  type deep-links on click (alert → asset, friend request → requests, chat →
  thread, …); route keys shared with FCM payloads via docs/mobile-push.md.
- **V4-P0d — Admin controls (M, diff:intermediate):** per-user chat ban
  (server-enforced, threads stay readable, instant unban); account-defaults
  panel for NEW accounts (notification matrix, chat on/off, portfolio starter
  defaults, inert developer-status default for V6-9); light admin IA regroup
  (deep redesign stays V6-1).
- **V4-P1 — Mobile API enablement I (M/L, diff:hard, security):** API-key/OAuth
  scope expansion (social:write, notifications:r/w, account:security, chat:r/w —
  naming planner-refined, §16-logged), enforced per route group in the bearer
  middleware, scope pickers with plain-language descriptions, strictly additive;
  bearer parity for settings/security/sessions/notifications/chat/social writes
  (inventory the cookie-only routes first; CSRF stays a cookie-only concern).
- **V4-P2 — Mobile API enablement II (M/L; three arcs):** Idempotency-Key UUID
  on ALL portfolio mutations with key→response persisted ≥48 h and replay on
  duplicates (offline-queue backbone, diff:hard); OAuth account chooser — the
  authorize page ALWAYS interposes "signed in as X — Continue / Use another
  account", incl. first-party auto-approve clients (diff:normal); account
  deletion — re-auth + typed confirm, hard-delete everything, chat anonymized,
  sessions revoked; Play-required (diff:hard).
- **V4-P3 — FCM push go-live (M, diff:intermediate; needs V3-P11c):** real FCM
  sends with owner Firebase credentials (env-gated), unregistered-token cleanup,
  docs/mobile-push.md payload + deep-link contract for the app track; physical
  Android device test at the gate.
- **V4-P4 — Registration modes + Google login + passkeys (L, diff:hard, auth):**
  admin-switchable closed/invite-token/approval-queue/open (§6.12) with invite
  management + decision emails + mode-aware surfaces; Google OAuth sign-in
  (links by verified email or registers per active mode); WebAuthn passkeys
  (multiple named, Settings → Security, alongside 2FA).
- **V4-P5 — Product ops (M; two arcs):** Sentry api+web (env-gated DSN,
  unit-tested PII scrubber, release tags) + bull-board admin-only + admin health
  page (DB/Redis/provider/queue/gateway, version, uptime); announcements —
  admin EN+DE composer, dismissible banner + inbox entry, per-user dismissal.
- **V4-P6 — Data lifecycle (M; two arcs):** account data export (async zip —
  JSON of every user-owned entity + CSVs; expiring re-auth-gated link; 1/day)
  and offsite backup (daily pg_dump → age/GPG encrypt → Google Drive via
  rclone, 30-day retention, documented restore drill).
- **V4-P7 — Backtest: custom benchmark + rebalanced mode (L, diff:max,
  engine):** benchmark = any catalog asset OR one of the user's conglomerates
  through the same engine, full stats side-by-side + delta column; scheduled
  monthly/quarterly/yearly rebalancing generalizing the V3 entry-day primitive
  (shared code, not duplicated); late-listing composition §16-logged.
- **V4-P8 — Broker CSV imports (L, diff:max, money-math):** framework + Trade
  Republic/George/Flatex/IBKR mappers; autodetect → normalized staging →
  preview with mapped/unmapped/duplicate flags → transactional apply into a
  chosen portfolio + cash source; content-hash dedupe; per-row error tolerance;
  anonymized fixtures per broker; explicit non-goal: broker-API sync.
- **V4-P9 — Ideas (M/L, diff:intermediate; needs v3 chat + audiences):** "Save
  as idea" persists a named Workboard state (conglomerate ref or ad-hoc set +
  backtest params + thesis note); an Ideas list reopens it exactly; audience
  picker + friction ladder apply; new group in friend rows/Shared-With-Me; chat
  chips carry ideas or bare asset suggestions — sending never widens access.
- **V4-P10 — Telegram & Discord channels (S/M bundle, diff:normal):** two
  NotificationChannel impls — Telegram bot (env-gated token, code-handshake
  link/unlink) and Discord per-user webhook (validated + test button); matrix
  columns appear only when configured; secrets never logged.
- **V4-P11 — DE sweep, e2e, v4 gate:** human-eye DE pass; empty/error/loading
  sweep; Playwright extended (bearer scopes, deletion, invite registration,
  mocked Google login, virtual-authenticator passkey, import preview→apply,
  benchmark compare, idea share→clone, announcements); pre-release top-tier
  review (Opus 4.8 max); file **check v4**.

After all V4-P0…P11: the composer files one `awaiting-owner` **"check v4"** issue
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
