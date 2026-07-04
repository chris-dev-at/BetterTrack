# BetterTrack — Project Plan (v2)

| | |
|---|---|
| **Status** | Approved blueprint v2 — supersedes plan v1 per owner issue #79 |
| **Last updated** | 2026-07-01 |
| **Owner** | chris-dev-at |
| **Repo** | https://github.com/chris-dev-at/BetterTrack |

This document is the single source of truth for what BetterTrack is and how it is built. Sections 1–13 describe the **V1 scope** ("BetterTrack Core + Tiny Friend Sharing", per the owner's V1 definition in issue #79). Everything beyond that lives in **Section 14 — Future Features**, deliberately kept rich so features can be picked up later without re-designing. Where this v2 plan changes something the codebase already implements, the milestone phases in §13 schedule the rework.

---

## 1. Vision & Goals

BetterTrack is a self-hosted **personal finance and investing workspace**: users track multiple portfolios, browse assets, build **Conglomerates** (ETF-style weighted baskets), backtest strategies, turn budgets into buy lists, share portfolios and ideas with friends, and — later — connect their own tools through an API.

The app is organized around **five main navigation areas**, final from V1 onward:

**Portfolio | Workboard | Assets | Social | Profile Menu**

**Core promises:**

1. **Track** — record real buys/sells; see value, profit/loss, top winners/losers and history of everything you own, market-listed or not (your car, your house, an unlisted stock). Multiple portfolios (private, firm, shared) are the design target; V1 ships one default portfolio on a multi-portfolio data model.
2. **Play** — the Workboard is a financial playground: watchlists, Conglomerates with percentage weights, backtests, and a budget calculator that turns "1000 €" into a concrete buy list (whole-share or fractional) that never overshoots.
3. **Browse** — the Assets section is a full asset browser with a **local search index**: searching "bayer" hits BetterTrack's own catalog, not a live provider round-trip. Asset pages chart history and offer quick actions into the rest of the app.
4. **Share** — add friends inside BetterTrack; share a portfolio read-only with friends (V1); later: shared/editable portfolios, ideas, public profiles and links.
5. **Private & polite** — closed by default (admin decides the registration mode); the server does almost nothing while nobody interacts; upstream data providers are never spammed — everything is cached and coalesced.

**Non-goals (V1):** not a broker (no order execution), no investment advice, no mobile app / Firebase, no bank APIs, no public social network (feed/comments/likes/chat), no OAuth app marketplace, no second-by-second Live Mode streaming, no Google Drive backups.

**Success criteria for V1:** an invited user logs in, finds BAYN.DE instantly via local search, watches it, builds a 13/40/47 Conglomerate, backtests it, turns 1000 € into a buy list, records those buys next to their house in their portfolio, flips "share with friends" on, and their friend sees the portfolio read-only under Shared With Me — with a bell notification and a logged email on the way. The admin manages accounts and global app settings from a separate admin area and has **no** portfolio of their own. All five tabs exist; not-yet-built surfaces say "Coming soon" instead of not existing.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Asset** | Anything trackable with a price/value over time. Market assets come from a data provider; **custom assets** (house, car, unlisted stock) get their values from the user. One unified concept — charts, portfolio math and backtests treat them identically. |
| **Asset catalog** | BetterTrack's own Postgres-backed index of known assets, powering **local search** (§6.2). Providers fill it; users search it. |
| **Provider** | A pluggable source of asset data implementing the `AssetProvider` interface. V1: `yahoo` (market data) and `manual` (custom assets). |
| **Quote** | Latest known price of an asset + day change, currency, timestamp. |
| **Portfolio** | A record of real ownership, derived from transactions. A user can have several (V1: one default; schema is multi-portfolio). Has a **visibility**: `private` or `friends` (read-only). |
| **Transaction** | One buy or sell: asset, quantity, price, fee, timestamp. |
| **Custom investment** | A user-created asset with manually entered **value points**; values carry forward between points. |
| **Workboard** | The playground tab: watchlist, Conglomerates, backtests, calculators; later comparisons and saved ideas. Watching ≠ owning. |
| **Conglomerate** | A named basket of assets with percent weights summing to 100 — the user's "own ETF". |
| **Position** | One entry of a Conglomerate: asset + weight percent. |
| **Backtest** | Historical performance of a Conglomerate, computed from daily closes as a weighted buy-and-hold index. |
| **Invest Calculator** | Turns (Conglomerate + budget) into a concrete buy list, whole-share or fractional, never exceeding budget. |
| **Friend** | A mutual, accepted connection between two users. Created via friend request (by username or email); either side can remove it. |
| **Live Mode** | An asset-chart mode showing short real-time windows (1 m … 12 h) fed by **one shared stream per asset** regardless of viewer count. V1: button exists, marked Coming soon. |
| **Alert** | A rule on an asset (price above/below, ±X%) that fires a notification. Designed (schema exists), **post-v1**. |
| **Notification channel** | Pluggable delivery: in-app + email (V1); phone push / Telegram / Discord later. |
| **Email log** | Per-user record of every email the system sent (or failed to send) for that user; visible to the admin. |
| **Registration mode** | Global admin setting for how accounts come to exist: closed · invite/token · approval · open (§6.12). |
| **Account kind** | `user` (uses the app) or `admin` (management-only; no portfolio, no user features — §3). |
| **Coming Soon page** | A real routed page/section rendered as a designed placeholder, so the final structure is visible before the feature ships. |
| **Base currency** | Currency everything is converted to for totals/charts. V1: EUR (per-user setting is a Future Feature). |

---

## 3. Users & Access Model

- **User** — a normal account. Has email (required), username, password. Uses the entire app. Sees other users' data only through Social: portfolios friends explicitly shared, plus (later) shared links/profiles.
- **Admin** — a **management-only account kind**, not a superpowered user. Admins administer the system in their own admin area (served on the admin origin, §4.6/§11): accounts, invites, audit log, email log, global app settings. Admins have **no portfolio, no workboard, no friends — no user-app features at all**; the user API rejects admin sessions and vice versa. If an admin wants to try the app, they create a separate test user account. Admin cannot browse users' portfolios (privacy stance — deliberate).
- **Friends** — users connect via friend requests (username or email). Friendship is mutual and revocable; it is the only V1 sharing audience.
- **How accounts come to exist** is governed by the global **registration mode** (§6.12): V1 runs in **closed mode** (admin-created accounts + invite links, exactly as today); invite/token, approval and open modes are designed and visible in admin settings, enabled post-v1.

**Email is mandatory on every account** — it is the identity for invites, password handling and the primary notification channel.

---

## 4. System Architecture

### 4.1 Three layers, strictly separated

```
┌────────────────────────────────────────────────────────────┐
│ DISPLAY LAYER — runs on the user's machine                 │
│   BetterTrack Web (React SPA, static files)                │
│   future: mobile app (Firebase push), CLI, widgets,        │
│   third-party API clients — all equal API clients          │
└──────────────▲─────────────────────────▲───────────────────┘
               │ REST /api/v1 (JSON)     │ WebSocket (push, post-v1)
┌──────────────┴─────────────────────────┴───────────────────┐
│ BUSINESS LAYER — BetterTrack Core (Node/Express service)   │
│   HTTP API · /docs · Services · Domain logic               │
│   Notifications · Jobs/Scheduler · Domain events           │
└──────▲──────────────▲──────────────▲───────────────────────┘
       │              │              │ AssetProvider interface
┌──────┴──────┐ ┌─────┴─────┐ ┌──────┴──────────────────────┐
│ DATA LAYER  │ │           │ │ External market data        │
│ PostgreSQL  │ │   Redis   │ │  yahoo (V1) · manual (V1)   │
│ (records)   │ │cache/queue│ │  crypto/gold providers later│
└─────────────┘ └───────────┘ └─────────────────────────────┘
```

**Principles (rules, not suggestions):**

1. **The display layer is dumb.** The SPA is static files served with long-lived cache headers; after load it runs entirely in the browser. Server cost per user ≈ API calls only.
2. **API-first.** Every feature is an API endpoint first; the web app is merely the first consumer. A future mobile app (or the owner's smart fridge) uses the same `/api/v1` — zero backend changes. The internal API is documented at **`/docs`** on the API origin (§6.13).
3. **All logic lives in the business layer.** The SPA never computes anything authoritative.
4. **Be polite upstream.** Every provider byte is cached; concurrent identical requests coalesce into **one** upstream fetch; N users viewing the same asset (or, later, the same live stream) cost one provider request. This is a correctness requirement, not an optimization (§5.3).
5. **Data sources are pluggable.** Nothing outside `providers/` knows Yahoo exists.
6. **Modular monolith.** One deployable backend with strict internal module boundaries. Realtime push (Socket.IO gateway, rooms per §4.5) is designed in but **implemented post-v1** — V1 clients stay fresh via TanStack Query refetch, which the architecture must keep sufficient.

### 4.2 Repository layout (pnpm monorepo, TypeScript everywhere)

```
bettertrack/
├── apps/
│   ├── web/                  # DISPLAY: React SPA (user app + admin app)
│   └── api/                  # BUSINESS: Express service (+ worker entrypoint)
├── packages/
│   ├── contracts/            # Shared zod schemas, TS types, typed API client
│   └── config/               # Shared tsconfig, eslint, prettier
├── infra/
│   ├── docker-compose.yml    # prod topology
│   ├── docker-compose.dev.yml# db+redis only, apps run locally
│   ├── nginx/                # both deployment modes (§11)
│   └── .env.example
├── factory/                  # autonomous build factory (prompts, runner)
├── docs/                     # auxiliary docs (runbooks) — see below
├── CLAUDE.md · MODELUSE.md · PROJECTPLAN.md · README.md   # root docs (stay at root)
```

**Root docs tidy (executed in P0):** auxiliary documents move to `docs/` — `STARTAUTOMATE.md` → `docs/STARTAUTOMATE.md` (factory runbook) and `FableBackExecute.md` → `docs/FableBackExecute.md` (kept as the outage-runbook template). `CLAUDE.md`, `PROJECTPLAN.md`, `MODELUSE.md`, `README.md` stay at root. Anything referencing the moved files updates its links.

`packages/contracts` is the keystone: every request/response body is a zod schema defined once, used by the API for validation, by the SPA for types, by `/docs` for OpenAPI generation, and later by mobile/third-party clients.

### 4.3 Backend internal structure (`apps/api/src/`) — target module layout

The existing layout already matches; v2 is **additive** (new modules marked ✚). A T3 agent creates the new directories as their phases land; no existing files move.

```
config/          # env schema — incl. deployment topology & derived origins (§11)
http/            # Express routes/controllers — THIN: parse → call service → respond
  routes/        # auth, admin, assets, search, workboard, portfolio, customAssets
                 #   ✚ conglomerateRoutes ✚ socialRoutes ✚ notificationRoutes
                 #   ✚ settingsRoutes ✚ docsRoutes
  middleware/    # session, csrf, rateLimit (progressive, §10), validate
docs/          ✚ # OpenAPI generation from contracts + the /docs page (§6.13)
services/        # business orchestration; one directory per module:
                 #   auth/ sessions/ password/ crypto/ audit/ admin/
                 #   assets/ customAssets/ currency/ portfolio/ workboard/
                 #   email/ (gains emailLog)
                 #   ✚ search/ (local catalog index)  ✚ conglomerates/
                 #   ✚ social/ (friends + sharing)    ✚ notifications/
                 #   ✚ appSettings/ (global admin settings)
domain/          # PURE functions, no I/O: holdings, backtest, ✚ allocation
                 #   (post-v1: alertEval). 100% unit-testable, the most-tested code.
data/            # Drizzle schema + repositories (all SQL lives here)
providers/       # AssetProvider interface, registry, yahoo, manual,
                 #   cache/coalescing/circuit-breaker/request-queue (§5.3)
jobs/            # BullMQ queues, processors, cron schedules
events/          # Domain event bus (typed), producers/consumers
realtime/        # post-v1: Socket.IO gateway (rooms per §4.5) — do not create until built
scripts/         # migrate, seed, worker entrypoints
testing/         # shared test harness
```

**Dependency rule:** `http`/`realtime`/`jobs` → `services` → `domain` + `data` + `providers`. Never the reverse; `domain` imports nothing but types.

### 4.4 Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript end-to-end | One language, shared types via `contracts` |
| Frontend | React 19 + Vite + Tailwind 4 + react-router 7 | Static SPA build, fast dev loop |
| Client data | TanStack Query + typed API client | Caching, retries, focus-refetch = polite to the server |
| Charts | `lightweight-charts` + Recharts (donuts/bars) | Finance-grade charts, tiny footprint |
| Backend | Node 22 + Express 5 | Boring, proven |
| Validation | zod (schemas in `contracts`) | Single definition for API + client + OpenAPI |
| ORM / DB | Drizzle ORM + **PostgreSQL 17** | Typed SQL; also hosts the search index (`pg_trgm` + tsvector) |
| Cache / queues / sessions | **Redis 7** | Quote cache, BullMQ jobs, session store, rate-limit state |
| Jobs | BullMQ | Scheduled + retryable background work |
| Auth | Session cookies (httpOnly) + argon2id | Right fit for a closed-by-default app; API keys/OAuth post-v1 (§6.13) |
| Email | Nodemailer over SMTP — **Gmail app password is the first-class preset** (§6.10) | Owner runs a Gmail sender; every send is written to the per-user email log |
| Market data | `yahoo-finance2` behind the provider interface | Free, EU coverage; unofficial → aggressively cached, coalesced, swappable |
| API docs | OpenAPI 3 generated from contracts, rendered at `/docs` | People can integrate BetterTrack into their own tools |
| Realtime (post-v1) | Socket.IO (Redis adapter) | Rooms, reconnects — for alerts, Live Mode, live shares |
| Mobile (future) | Same REST API + Firebase Cloud Messaging for push | Designed-for, not built; a new NotificationChannel + API client, no backend rewrite |
| IDs | UUIDv7 · Deploy: Docker Compose · CI: GitHub Actions | Sortable ids; reproducible deploys; typecheck/lint/test/build per push |

### 4.5 Realtime gateway (designed now, built post-v1)

Socket.IO endpoint at `/ws` on the API origin, authenticated via the session cookie on handshake. Rooms: `user:{id}` (notifications, portfolio changes), `asset:{id}` (quote updates, Live Mode frames), `portfolio:{id}` (shared-portfolio viewers). Services publish typed **domain events** on the internal bus (`events/`, already implemented); the gateway and the notification dispatcher are subscribers. V1 explicitly ships without the socket: the SPA's refetch behavior must keep every V1 feature fully functional — the gateway is an enhancement layer for alerts, Live Mode and live shared views when they land.

### 4.6 Deployment topology

BetterTrack must be **flexible to set up anywhere**. Two supported modes, one global config (full env scheme in §11):

- **Subdomains mode** (default): three origins on one domain — `api.<domain>`, `web.<domain>`, `admin.<domain>`. Subdomain names are configurable; TLS terminates at the front proxy.
- **Ports mode**: no subdomains — everything on one host, each service on its own configurable port (e.g. `host:8080` web, `host:8081` admin, `host:3000` api).

| Service | Image / role | Notes |
|---|---|---|
| `web` | nginx serving `apps/web/dist` | Serves the SPA for **both** the web and admin origins (host- or port-based server blocks, §11); injects runtime config telling the SPA which app to mount |
| `api` | Node (apps/api, entry `server.ts`) | HTTP API + `/docs` (+ WebSocket post-v1) |
| `worker` | Same image, entry `worker.ts` | BullMQ processors |
| `db` | postgres:17 | Volume `pgdata`; nightly `pg_dump` to volume `backups` |
| `redis` | redis:7 | AOF persistence on |

The API is its own origin in both modes; the SPA calls it cross-origin with credentials. CORS allowlist and cookie attributes are **derived** from the topology config (§10, §11) — never hand-maintained. Health: `GET /api/v1/health`.

---

## 5. Data Layer

### 5.1 The provider abstraction (the "trackable" core)

Everything price-like flows through one interface:

```ts
type AssetRef = { providerId: string; providerRef: string }; // e.g. { 'yahoo', 'BAYN.DE' }

interface AssetProvider {
  readonly id: string; // 'yahoo' | 'manual' | future: 'coingecko', 'metals', ...

  search(query: string): Promise<AssetSearchResult[]>;   // catalog-fill only, never user-facing hot path (§6.2)
  getQuote(ref: AssetRef): Promise<Quote>;               // price, currency, prevClose, dayChangePct, asOf
  getHistory(ref: AssetRef, range: Range, interval: Interval): Promise<PricePoint[]>;
  getMeta(ref: AssetRef): Promise<AssetMeta>;            // name, symbol, exchange, currency, type
}
```

- A central **registry** maps `providerId → instance`. Services call `registry.for(asset)` — nobody else knows which provider is behind an asset.
- **`manual` provider** backs custom investments: `getQuote` returns the latest value point, `getHistory` the value points with carry-forward. Portfolio charts and P/L need zero special-casing for a house vs. a stock.
- **FX pairs are just assets** (`yahoo:EURUSD=X`), reusing the same caching/backfill machinery.
- Failure handling: timeouts (5 s), retry-once, circuit breaker; on failure the API serves the last cached value marked `stale: true` rather than erroring (stale-while-revalidate).
- Adding crypto/gold later = registering symbols or a new provider file. Nothing else changes.

### 5.2 Market data: Yahoo Finance via `yahoo-finance2`

Capabilities used: `search()` (catalog-fill), `quote()`, `chart()` (OHLC history, dividend/split-adjusted closes — backtests are total-return). Known risk: unofficial API, can change or rate-limit. Mitigations: (a) every byte cached and coalesced (§5.3), (b) outbound calls run through a queue with bounded concurrency + exponential backoff on 429/5xx, (c) user-facing search never blocks on Yahoo (§6.2), (d) the provider interface makes replacement a contained change, (e) UI disclaimers (§10).

### 5.3 Caching & upstream-politeness (a keystone, owner priority)

**The rule: one piece of upstream data is fetched once per TTL window, no matter how many users want it.** Never compromise freshness by more than the TTL; never multiply requests by users.

| Data | Where | TTL | Notes |
|---|---|---|---|
| Quote | Redis | 60 s | One fetch serves every user viewing that asset |
| History 1D (1 m candles) | Redis | 60 s | |
| History 1W (15 m) | Redis | 5 min | |
| History 1M (30 m) | Redis | 15 min | |
| History 6M/1Y (1 d) | Redis | 1 h | |
| History 5Y (1 wk) / Max (1 mo) | Redis | 6 h | |
| Provider search results (catalog-fill) | Redis | 24 h | Keyed by normalized query; also upserted into the asset catalog |
| Negative results (unknown symbol, 404) | Redis | 15 min | So repeated misses don't hammer the provider |
| **Daily closes** (backtests/portfolio history) | **Postgres `price_history`** | permanent | Nightly refresh + on-demand backfill (§9) |
| FX daily rates | Postgres (FX assets in `price_history`) | permanent | |

Mandatory mechanics (all already partially in `providers/`; P1 hardens them to this spec):

- **Request coalescing** on every cache key (`{providerId}:{providerRef}:{kind}:{range}`): concurrent misses trigger exactly **one** upstream fetch; all callers await the same promise (in-process) backed by a short Redis lock (cross-process).
- **Serve-stale-while-revalidate**: an expired entry is returned immediately (marked `stale`) while one background refresh runs.
- **Per-provider request budget**: bounded concurrency + minimum spacing; 429 from upstream opens the circuit breaker and stretches TTLs instead of erroring users.
- **Live Mode (post-v1) inherits this**: one polling loop per hot asset feeds a Redis ring buffer; N viewers = 1 upstream stream, auto-stops when nobody watches.

### 5.4 Currency handling

- Every asset keeps its **native currency**; all stored amounts are native.
- Conversion happens at read/computation time in one place: `services/currency` (current rates for quotes/totals, historical daily rates for backtests and portfolio history).
- Base currency is **EUR**, but always a parameter (`toBase(amount, currency, date?)`) — per-user base currency (Future Feature) is a settings field + passthrough, not a refactor.
- Display: money 2 dp, quantities up to 6 dp, weights 1 dp (stored at higher precision).

### 5.5 Database schema (PostgreSQL, via Drizzle)

Conventions: `id uuid pk` (UUIDv7), `created_at/updated_at timestamptz` (UTC, displayed Europe/Vienna); `numeric(20,8)` quantities, `numeric(20,6)` prices/values, `numeric(6,3)` weights. Existing tables carry over; v2 changes are marked ✚ (new) or Δ (changed).

```
users               id, email UNIQUE NOT NULL, username UNIQUE NOT NULL,
                    password_hash, role ENUM(user, admin), status ENUM(active, disabled),
                    must_change_password bool, base_currency char(3) DEFAULT 'EUR',
                    Δ pin_hash NULL, Δ pin_enabled bool DEFAULT false,      -- §6.1 PIN option
                    last_login_at, created_at, updated_at
                    -- Δ role is an ACCOUNT KIND, not a permission flag: role=admin is a
                    --   management-only account with no user-app data (§3). Admin accounts
                    --   never get a default portfolio; user endpoints reject them.

invites             id, email NOT NULL, token_hash UNIQUE, created_by → users,
                    expires_at (default +7 days), used_at NULL, revoked_at NULL

app_settings      ✚ key text PK, value jsonb, updated_at, updated_by → users
                    -- global admin settings: registration_mode ENUM(closed, invite_token,
                    --   approval, open) DEFAULT closed; beta_mode bool; future flags (§6.12)

assets              id, provider_id, provider_ref, owner_id NULL → users,
                    type ENUM(stock, etf, index, fx, commodity, crypto, custom),
                    symbol, name, exchange NULL, currency char(3), meta jsonb,
                    Δ search_text tsvector GENERATED (symbol+name), GIN index;
                    Δ pg_trgm GIN index on (symbol, name) for fuzzy matching   -- §6.2
                    UNIQUE(provider_id, provider_ref, owner_id)
                    -- owner_id NULL = global catalog asset; set = that user's custom asset

price_history       asset_id → assets, date, close numeric, UNIQUE(asset_id, date)
                    -- daily adjusted closes; FX pairs and custom value points included

workboard_items     id, user_id, asset_id, sort_order int, note NULL, UNIQUE(user_id, asset_id)

alerts              (exists; feature is post-v1 — kinds/lifecycle spec preserved in §14)

notifications       id, user_id, type, title, body, payload jsonb, read_at NULL, created_at
                    -- v2 types: friend.request, friend.accepted, portfolio.shared,
                    --   account.invite, account.temp_password (alert.triggered post-v1)

notification_settings  user_id, channel ENUM(inapp, email, telegram, discord),
                       enabled bool, config jsonb, UNIQUE(user_id, channel)

email_log         ✚ id, user_id NULL → users, to_email, template, subject,
                    status ENUM(sent, failed, suppressed), error_code NULL,
                    triggered_by NULL → users, created_at
                    -- every outbound email, queryable per user in admin (§6.10); no bodies stored

friend_requests   ✚ id, from_user → users, to_user → users, status ENUM(pending, accepted,
                    declined, cancelled), created_at, responded_at NULL,
                    UNIQUE(from_user, to_user) WHERE status='pending'

friendships       ✚ user_a → users, user_b → users, created_at, PK(user_a, user_b)
                    -- stored with user_a < user_b (one row per pair); created on accept

conglomerates       id, owner_id → users, name, description NULL,
                    status ENUM(draft, active), created_at, updated_at

conglomerate_positions  id, conglomerate_id, asset_id, weight_pct numeric(6,3),
                        sort_order int, UNIQUE(conglomerate_id, asset_id)

share_links         (exists; conglomerate share links are post-v1 — spec preserved in §14)

portfolios          id, user_id, name DEFAULT 'Main', UNIQUE(user_id, name),
                    Δ visibility ENUM(private, friends) DEFAULT private,   -- §6.8/§6.9
                    Δ sort_order int
                    -- V1: exactly one auto-created per user; ALL portfolio queries are
                    --   portfolio_id-scoped so multi-portfolio is purely additive (§6.8)

transactions        id, portfolio_id, asset_id, side ENUM(buy, sell),
                    quantity numeric(20,8) > 0, price numeric(20,6) >= 0,  -- native currency
                    fee numeric(20,6) DEFAULT 0, executed_at timestamptz, note NULL

api_keys            (post-v1, designed: id, user_id, name, token_hash, scopes jsonb,
                     last_used_at, revoked_at — API keys NEVER expire, only revoke; §6.13)

audit_log           id, actor_id NULL → users, action, target_type, target_id,
                    ip, meta jsonb, created_at
```

Sessions live in **Redis** (not Postgres) — 30-day expiry semantics in §6.1. Deleting a user cascades to everything they own; friendships and pending requests involving them are removed.

---

## 6. Business Layer — Feature Specifications

Each spec defines behavior precisely enough to implement and test against. V1 scope markers: features are **V1** unless flagged **[Coming Soon]** (visible placeholder in V1) or **[post-v1]** (in §14).

### 6.1 Authentication, accounts & sessions

- **Login** (`POST /auth/login`, email-or-username + password): argon2id verify; on success rotate session ID, set `last_login_at`, audit-log. Generic error on failure (no user enumeration); a **disabled** account with the correct password gets `ACCOUNT_DISABLED` (see §16, 2026-06-16). An **admin** account logging into the user app gets a clear error pointing at the admin origin (and vice versa) — the two apps authenticate the two account kinds disjointly.
- **Sessions:** httpOnly, `SameSite=Lax`, `Secure` (prod) cookie → Redis session. **Sessions expire after 30 days.** The 30-day window renews on login and on **PIN entry** (below) — so the logout only happens after 30 days without either. Password change or account disable kills all sessions of that user instantly. **API keys (post-v1) never expire** — revocation only.
- **PIN option (V1):** a user can enable a PIN in Settings → Security. With PIN on, every time the website is (re)opened the SPA shows a PIN screen before the app; a correct PIN (`POST /auth/pin/verify`, argon2id-hashed, rate-limited like login) **renews the 30-day session window**. The PIN is a convenience re-confirmation layered on the session, not a second factor; 5 consecutive failures fall back to full login.
- **2FA (planned, post-v1):** TOTP-based two-factor login is designed-for (enrollment + recovery codes under Settings → Security); noted here so session/login code keeps a hook for a second verification step.
- **Forced password change:** temp-password accounts have `must_change_password=true`; every API call except `change-password`/`logout` returns `403 PASSWORD_CHANGE_REQUIRED`; the SPA traps this into the change screen.
- **Invite accept** (`GET /invite/:token` page → `POST /auth/accept-invite`): token valid = unused, unrevoked, unexpired (7 days). Email fixed from the invite; user picks username + password; logged in immediately. Invites always create **user**-kind accounts.
- **Registration modes** beyond invites are governed by admin global settings (§6.12); V1 enforces `closed`.
- **Password policy:** ≥ 10 chars, no composition rules, top-10k-common-passwords blocklist. Temp passwords: 16-char random, shown to the admin exactly once.
- **Progressive rate limiting** (spec in §10): normal users should almost never notice limits; escalating short cooldowns replace long blocks.
- **Login UI:** the login card sits **top-middle-ish** — horizontally centered, vertically a little above center (not bottom-anchored, not glued to the top).

### 6.2 Search & the local asset catalog (owner priority)

Search is **local-first**: BetterTrack maintains its own asset catalog and searches it — a user typing "bayer" must never trigger a synchronous Yahoo round-trip, and partial/fuzzy queries must work.

- **Catalog:** the global rows of `assets`, indexed with tsvector + `pg_trgm` (§5.5). Filled by: (a) provider search results (every provider search upserts its results), (b) history backfill/metadata jobs, (c) an optional seed list of common symbols (major indices, DAX/ATX/S&P constituents) shipped with the app, (d) users' custom assets (owner-scoped).
- **Query path** (`GET /search?q=`): normalize query → catalog lookup (prefix + trigram similarity + full-text over symbol/name, ranked: exact symbol > symbol prefix > name match > fuzzy) merged with the user's custom assets. Responds immediately from Postgres.
- **Provider fallback:** if the catalog yields < 3 results, a provider search runs **in the background** (budgeted, coalesced per §5.3, 24 h-cached per normalized query) and upserts into the catalog; the client refetches after a short delay ("Searching providers…" affordance) and sees the enriched results. Misspellings and partial names therefore work from the catalog's trigram index even when providers would 404.
- Results: symbol, name, exchange, type badge, currency. Actions on every result: **→ Watchlist**, **→ Conglomerate** (picker), **→ Portfolio** (buy dialog).
- First time any user touches a market asset, it is upserted into `assets` and a history backfill job is enqueued.
- UI: search lives in the **Assets** section + global **Cmd/Ctrl-K palette** from anywhere. Debounce 300 ms, min 2 chars.

### 6.3 Assets section & asset detail

**Assets** is the browser/discovery tab for everything BetterTrack knows. Subnavigation: **Overview | Search | Stocks | ETFs | Crypto | Commodities | Custom Assets**. V1 implements Overview (simple entry: search box + recently viewed + catalog counts), Search, and asset detail; the per-category browse pages and advanced filters are **[Coming Soon]** placeholders.

**Asset detail page:**
- Chart (lightweight-charts, area style) with ranges **1D · 1W · 1M · 6M · 1Y · 5Y · Max** (range→interval mapping = cache table §5.3). Custom assets: value points, step-line.
- Header: name, symbol, exchange, native price + day change (green/red), EUR-converted price if foreign, `asOf` timestamp + `stale` marker, "data may be delayed" footnote.
- Stats row (when the provider supplies it): prev close, day range, 52-week range, market state.
- **Live Mode [Coming Soon in V1]:** a `LIVE` toggle on the chart switches from historical ranges to short real-time windows (1 m · 10 m · 30 m · 1 h · 3 h · 12 h — exact windows adjustable later). Design (built post-v1): the worker polls each hot asset **once** into a Redis ring buffer and fans out to all viewers via `asset:{id}` rooms — four users watching live BAYN.DE = one provider stream; polling auto-stops when nobody watches. V1 ships the button marked Coming soon; the V1 chart may refresh the quote every 60 s (cache-served) as a light preview, with no second-level streaming.
- **Quick actions:** add to Portfolio (buy dialog), add to Watchlist, add to Conglomerate; *Appears in* section (your conglomerates/holdings). [Coming Soon]: share to Social, suggest to a friend, alerts on this asset.

### 6.4 Workboard — the playground

The Workboard is where users **experiment** before committing money: try baskets, backtest, calculate — a toolbox, not an accounting page. Subnavigation: **Overview | Conglomerates | Watchlists | Backtests | Calculators | Comparisons | Saved Ideas**.

V1 implements:
1. **Overview** — entry cards: watchlist summary, "My Conglomerates" grid (name, positions count, mini-chart, → detail, "New Conglomerate"), quick links to calculator/backtest.
2. **Watchlist** — table of watched assets: sparkline (1M), price, day ±%; drag-to-reorder, per-row note, remove. Empty state points to Assets search. (V1: one watchlist; named multiple watchlists **[Coming Soon]**.)
3. **Conglomerates** — list + Builder + detail (§6.5) with backtest (§6.6) and calculator (§6.7).

**[Coming Soon]** in V1: Comparisons, Saved Ideas, watchlist sharing, standalone Backtests/Calculators pages beyond the conglomerate-embedded ones. **[post-v1]**: price alerts & the alerts panel (spec preserved in §14 — schema already exists).

### 6.5 Conglomerates & the Builder

**Model rules:** 1–50 positions; weights `0 < w ≤ 100` with ≤ 3 decimals; **status `active` requires Σ weights = 100 ± 0.01**; `draft` allows any state. Names unique per owner (case-insensitive). Deleting (confirm dialog) hard-deletes.

**The Builder** (`/workboard/conglomerates/new`, `…/:id/edit`) is a full-screen experience — the flagship UX:
- **Left — Add assets:** embedded search; click adds a position at weight 0.
- **Center — Positions:** per row: symbol/name, weight number-input (0.001 precision) + slider (0–100, step 0.5), **lock toggle** 🔒, remove. Footer: live **sum pill** — green "100.0%" when valid, amber "87.5% — 12.5% left" otherwise.
  - **Auto-balance:** distributes `100 − Σ(locked)` equally across unlocked positions.
  - **Normalize:** scales unlocked positions proportionally to hit exactly 100 (locked untouched; error if locked alone ≥ 100).
- **Right — Live preview:** allocation donut + backtest chart (1Y/3Y/5Y/Max) + headline stats, recomputed **debounced 500 ms** after any weight change (fast because `price_history` is warm).
- **Autosave:** every change persists to the `draft` immediately ("Draft — saved" pill). "Activate" validates and flips to `active`.

**[Coming Soon]** in V1: sharing conglomerates to friends, public share links, JSON export/import (incl. the legacy `conglomerate.py` format — full spec preserved in §14), nested conglomerates, rebalanced backtests.

### 6.6 Backtest engine

Pure function in `domain/backtest.ts` (implemented):

```
Inputs:  positions[{assetId, weight}], range, baseCurrency (EUR)
Data:    daily adjusted closes from price_history; daily FX from FX assets
Method:  1. Window = requested range, clipped to the latest first-available
            date across positions ("common start"). If clipped, the response
            carries a notice: "Limited by TEM (data since 2024-06-14)".
         2. Convert each series to EUR using that day's FX rate;
            carry forward last close over non-trading days per asset.
         3. index(t) = 100 · Σᵢ wᵢ · Pᵢ(t)/Pᵢ(t₀)   (buy-and-hold of initial
            weights — no rebalancing; documented limitation, rebalanced mode
            is a Future Feature. Adjusted closes ⇒ dividends included.)
Outputs: series[{date, value}], stats: total return %, CAGR, max drawdown,
         annualized volatility (σ of daily returns × √252), best/worst day,
         per-position contribution; optional benchmark overlay series.
```

- Benchmarks: overlay toggle for `^GSPC` (S&P 500), `^GDAXI` (DAX), `URTH` (MSCI World) — same pipeline, weight 100.
- API: `GET /conglomerates/:id/backtest?range=5y&benchmark=^GSPC`; unsaved Builder state: `POST /backtest/preview`.
- Results memoized in Redis 1 h keyed by hash(positions+range) — slider-wiggling stays cheap.

### 6.7 Invest Calculator (budget → buy list)

Pure function in `domain/allocation.ts`. Inputs: active conglomerate, budget `B` in EUR, mode `whole | fractional` (+ optional fractional step, e.g. 0.0001). Prices: current quotes EUR-converted. **Hard guarantee: total cost ≤ B. Never overshoot.**

- **Fractional:** `qtyᵢ = (B·wᵢ)/pᵢ` rounded **down** to the step ⇒ spend ≈ B minus dust.
- **Whole shares:**
  ```
  1. targetᵢ = B · wᵢ
  2. qtyᵢ = floor(targetᵢ / pᵢ)                       # never above target
  3. leftover = B − Σ qtyᵢ·pᵢ
  4. while any share price ≤ leftover:
       among affordable assets, buy 1 share of the one that most reduces
       Σᵢ |actualᵢ − targetᵢ|  (tie-break: larger target weight first)
       update leftover
  5. emit per-position qty, cost, actual % vs target %, Δpp; totals + leftover
  ```
- **Worked example** (illustrative prices): B = 1000 €, BAYN.DE 30% @ 25 €, NVDA 60% @ 150 €, GOOGL 10% @ 140 €.
  Step 2: BAYN 12×25 = 300 €, NVDA 4×150 = 600 €, GOOGL 0×140 = 0 €. Leftover 100 € < 140 € ⇒ no fill possible. **Result: 900 € spent, 100 € left, GOOGL 0% vs target 10% — flagged: "GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1400 € or use fractional mode."** Unreachable weights are surfaced exactly like this, never silently mis-weighted.
- Edge cases: any single price > B ⇒ position flagged unbuyable; market closed ⇒ last close with notice; stale quotes ⇒ warning banner.
- **Buy flow:** result table → **Add to Portfolio** → dialog pre-filled with one BUY per non-zero position (qty/price from the calculation, `executed_at = now`, all editable) → confirm ⇒ bulk-insert. Two clicks from plan to recorded reality.

### 6.8 Portfolio — the home tab

Portfolio is the first tab and the app's home (`/` redirects here): *what do I own, what is it worth, how is it doing*.

- **Multi-portfolio model, one default in V1:** every user gets an auto-created default portfolio; **all queries, endpoints and services are `portfolio_id`-scoped** (`/portfolios/:id/…`) so additional portfolios are purely additive. V1 UI shows a **portfolio switcher placeholder** (current portfolio name + a disabled "New portfolio — Coming soon" affordance). Multi-portfolio UI, shared-editable portfolios and per-section privacy are **[Coming Soon]**.
- **Transactions are the source of truth**; holdings are derived, never stored.
  - BUY: quantity, price (native), fee, timestamp, note. SELL: same; rejected if held quantity would go negative.
  - **Average-cost basis:** buys re-average `avg_cost = (held_qty·avg_cost + qty·price + fee) / (held_qty + qty)`; sells reduce quantity, avg cost unchanged; realized P/L of a sell = `qty·(price − avg_cost) − fee` (shown on the row; FIFO/tax lots are Future Features).
- **Overview page (V1):** totals header (market value, invested, unrealized P/L €/%, day change €/%), performance chart (1M/6M/1Y/Max), holdings list, **top winners / top losers** among holdings (by day % and by total P/L toggle), allocation donuts (by asset / by type), recent transactions, quick add-transaction. Widget-based customizable layout is **[Coming Soon]** — V1 uses a fixed sensible arrangement of the same blocks.
- **Value-over-time chart:** daily series from first transaction: `Σ qty_held(d) · price_EUR(d)` from `price_history` + historical FX; custom assets contribute carried-forward value points. Cached 1 h, invalidated on any transaction/value-point change.
- **Custom investments:** create (name; category: real estate · vehicle · collectible · cash · unlisted stock · other; currency; optional initial BUY). **Value points** editor: (date, value) rows, one per day, carry-forward between points. A custom asset then behaves like any asset — chartable, holdable, watchable, even usable in conglomerates.
- **Visibility (V1):** per portfolio, `private` (default) or `friends` — the "Share this portfolio with friends: Yes/No" toggle (§6.9). Broker CSV imports (Trade Republic, George, …) are **[Coming Soon]** here and in Settings.

### 6.9 Social — friends & tiny sharing (V1 scope is deliberately small)

Subnavigation: **Friends | Shared With Me | My Shared Items** (+ **Ideas** and **My Public Profile** as **[Coming Soon]** pages).

The V1 friend system, complete:
1. A user enters another user's **username or email** → `POST /social/requests`. No user enumeration: the response is identical whether or not the target exists; a request to a nonexistent address simply never appears anywhere.
2. The target sees the request (bell notification + Friends page) and **accepts or declines**.
3. Accepted ⇒ one `friendships` row; both see each other in **Friends**. Either side can **remove** the friend (row deleted, no notification).
4. If a friend's portfolio has `visibility = friends`, it appears under **Shared With Me** → read-only portfolio view (holdings, totals, performance chart — no transactions detail beyond what the owner's overview shows, no edit affordances anywhere).
5. **My Shared Items** lists what I'm currently sharing (V1: my portfolios with the friends toggle on) with quick toggle-off.

Explicitly **not** V1: feed, comments, likes, chat, groups, public discovery, activity timeline, per-asset privacy rules, edit permissions, public profiles/links (all §14).

**Privacy boundary (test-gated):** every social read is scoped by an existing friendship **and** the owner's visibility flag at query time; revoking either instantly closes access (no caching of authorization). Non-friends receive 404, never 403.

### 6.10 Notifications, channels & the email log

```ts
interface NotificationChannel {
  readonly id: 'inapp' | 'email' | 'push' | 'telegram' | 'discord' | string;
  send(user: User, n: NotificationMessage): Promise<void>;
}
```

- **Registry + per-user settings** (`notification_settings`): in-app always on; email on by default. Adding a channel (phone push via Firebase, Telegram, Discord — all post-v1) = implement the interface, register it, add a settings toggle. The dispatcher fans out one `NotificationMessage` to all enabled channels, at-least-once, deduped per (user, event key).
- **V1 notification types:** `friend.request`, `friend.accepted`, `portfolio.shared` ("Anna shared her portfolio with friends"), `account.invite`, `account.temp_password`. (`alert.triggered` arrives with alerts, post-v1.)
- **In-app:** bell with unread badge, dropdown list, mark-read/mark-all; full list in Settings → Notifications. V1 freshness via TanStack Query polling/refocus-refetch; socket push upgrades this post-v1.
- **Email — Gmail app password first:** Nodemailer over SMTP; the documented, tested first-class configuration is a **Gmail account + app password** (`smtp.gmail.com:465`, §11). Any other SMTP still works. Minimal clean HTML templates: invite, temp password, welcome, friend request, portfolio shared.
- **Email log (V1):** every send attempt writes an `email_log` row — user, recipient, template, subject, sent/failed/suppressed, coarse error code, no bodies/secrets. Admin can view the log **per user** (§6.12) and globally. Failures retried 3× exponential; suppressed = channel disabled/unconfigured.

### 6.11 Settings

Settings is the central place for account- and system-level personal settings (reached via the profile menu). Subnavigation: **Account | Notifications | Imports & Exports | Connections | Backups | API Access | Security**.

V1 implements:
- **Account** — username/email display, change password, base-currency display (fixed EUR, marked), and privacy/sharing toggles (portfolio visibility, mirrors §6.8/§6.9).
- **Notifications** — per-channel toggles (in-app, email), full notification list.
- **Security** — sessions info ("signed in since …, expires after 30 days of inactivity"), **PIN enable/change/disable** (§6.1), 2FA section marked planned.

**[Coming Soon]** pages (routed, designed placeholders): Imports & Exports (broker CSV, account data export), Connections (Google login, third-party), Backups (Google Drive), API Access (API keys, OAuth apps — §6.13).

**Profile menu** (top-right icon, compact dropdown): **My Portfolio · Settings · Invite Others [Coming Soon] · Share Profile [Coming Soon] · Logout**.

### 6.12 Admin area & global app settings

- **Separate world, separate account kind:** the admin app is served on the **admin origin** (`admin.<domain>` or the admin port, §4.6/§11) with its own login and minimal layout. Backend routes under `/api/v1/admin/*` require an admin-kind session; user routes reject admin sessions (§3). Non-admins get 404 (no information leak). Audit-logged throughout. (During transition the SPA keeps `/admin/*` path-routing working in ports/single-origin dev; the admin origin is the production face.)
- **Users:** table (email, username, status, kind, last login, created) with search/filter. Actions: **create user** (temp password shown once), **invite** (7-day tokenized link, copy or auto-send via email), **disable/enable** (disable kills sessions instantly), **reset password**, **delete** (type-username-to-confirm; cascades). Plus per-user **email log** view (§6.10).
- **Global app settings (V1 page, `app_settings`):**
  - **Registration mode** — the four modes, visible as a selector:
    1. **Closed** *(V1 default, fully enforced)* — only admin-created users + invites.
    2. **Invite/access-token** *(post-v1 activation)* — self-serve registration page that requires a valid token.
    3. **Approval** *(post-v1)* — open registration form, accounts land as `pending` until admin approves.
    4. **Open** *(post-v1)* — automatic registration.
    In V1 the selector renders all four with the non-closed modes disabled and marked Coming soon; the enforcement plumbing reads the setting from day one so activating a mode later is a switch, not a rebuild.
  - **Beta mode** toggle placeholder; future app-wide feature toggles and access rules live here too.
- **Overview cards:** user count, active (≤ 30 d), pending invites, tracked assets, job queue health, emails sent (24 h).
- **Audit log:** filterable table.
- Explicitly **not** V1: admin browsing user portfolios (privacy), full feature flags, announcements, analytics, moderation tools (§14).

### 6.13 API access & `/docs`

- **API docs page (V1):** the API serves human-readable endpoint documentation at **`GET /docs` on the API origin** (e.g. `api.<domain>/docs`), rendered from an **OpenAPI 3 document generated from the zod contracts** (`GET /openapi.json`). Every `/api/v1` route appears with schemas, auth requirements and error envelope; CI fails if a route is missing from the spec. The page is public (it contains no secrets and the API itself remains session-guarded) — this is the front door for people integrating BetterTrack into their own tools.
- **API access as a product feature (post-v1, designed now):** users will mint **API keys / personal access tokens** (Settings → API Access) with scoped permissions, and later OAuth apps — enabling third-party phone apps, smart-fridge dashboards, home widgets, scripts. Rules already fixed: **API keys never expire** (revocation only, §5.5), key auth bypasses the PIN/session machinery but honors scopes, and every key-authenticated call is attributable. V1 ships the Settings placeholder + the `/docs` page; token issuance/OAuth is §14.

---

## 7. Display Layer — Web App

### 7.1 Principles

- Pure static SPA (Vite build → `dist/`), served by nginx with immutable cache headers; `index.html` no-cache. All rendering/routing/state in the browser — the server only answers JSON.
- **One build, two apps:** nginx injects a tiny runtime config (`window.__BT__ = { app: 'user' | 'admin', apiOrigin }`) per origin/port; `App.tsx` mounts `UserApp` or `AdminApp` accordingly (path-based `/admin/*` remains the dev fallback). The SPA talks to the API origin cross-origin with credentials (§4.6, §10).
- TanStack Query for all server state: per-endpoint `staleTime` mirroring server cache TTLs, refetch-on-focus, request dedup — a polite client by construction. No socket in V1; refetch keeps everything fresh.
- Dark theme default, light toggle later. Desktop-first, fully usable on mobile (responsive tables → cards). Skeleton loaders, error boundaries with retry, designed empty states, and a shared **ComingSoon** component for placeholder surfaces. Locale: `de-AT` formatting (1.234,56 €).
- Auth: cookie-based; 401 → login redirect; `403 PASSWORD_CHANGE_REQUIRED` → forced-change screen; PIN gate (§6.1) wraps the app when enabled.

### 7.2 Routes (user app — five sections)

| Route | Page | V1 status |
|---|---|---|
| `/login`, `/invite/:token` | Login (card top-middle-ish) · Accept invite | ✔ (restyle) |
| `/` | → redirect `/portfolio` | ✔ |
| `/portfolio` | Portfolio overview (default portfolio; switcher placeholder) | ✔ |
| `/portfolio/transactions` · `/portfolio/custom-assets` | Transactions · Custom investments | ✔ |
| `/workboard` | Workboard overview | ✔ |
| `/workboard/watchlist` | Watchlist | ✔ |
| `/workboard/conglomerates` · `…/new` · `…/:id` · `…/:id/edit` | List · **Builder** · Detail (backtest + calculator) | ✔ |
| `/workboard/comparisons` · `/workboard/ideas` | Comparisons · Saved Ideas | Coming Soon |
| `/assets` | Assets overview (search entry, recently viewed) | ✔ |
| `/assets/search` | Search results (+ global ⌘K palette) | ✔ |
| `/assets/:id` | Asset detail (chart, quick actions, LIVE button = Coming soon) | ✔ |
| `/assets/stocks` · `/assets/etfs` · `/assets/crypto` · `/assets/commodities` · `/assets/custom` | Category browsers | Coming Soon |
| `/social` → `/social/friends` | Friends (requests in/out, list) | ✔ |
| `/social/shared-with-me` | Shared With Me (+ friend portfolio read-only view) | ✔ |
| `/social/my-shared` | My Shared Items | ✔ |
| `/social/ideas` · `/social/profile` | Ideas · My Public Profile | Coming Soon |
| `/settings/*` | Settings subpages per §6.11 | ✔ + Coming Soon mix |
| `/pin` | PIN gate (when enabled) | ✔ |
| admin origin (or `/admin/*`) | Admin app: login, users, invites, email, audit, **settings** | ✔ |

Header: **BetterTrack wordmark — Portfolio — Workboard — Assets — Social — 🔔 — profile icon** (dropdown per §6.11). The main nav never grows beyond these; deeper tools live in each section's subnav.

### 7.3 Target directory layout for `apps/web/src` (P0 executes these moves)

```
apps/web/src/
├── main.tsx · App.tsx          # runtime-config mounting (user vs admin app, §7.1)
├── index.css · vite-env.d.ts
├── lib/                        # apiClient + per-area API modules (unchanged location)
├── ui/                         # shared presentational components incl. charts/ (unchanged)
│   └── ComingSoon.tsx        ✚ # the placeholder component
├── components/                 # cross-app bits (Wordmark) (unchanged)
├── admin/                      # admin SPA: AdminApp, AuthContext, components/, pages/
│   └── pages/SettingsPage.tsx ✚ # global app settings (§6.12)
├── user/
│   ├── UserApp.tsx · AuthContext.tsx · RequireUser.tsx
│   ├── components/             # AppLayout (5-tab nav + profile dropdown + bell),
│   │                           #   dialogs, AssetSearchBox, CmdKPalette, ui
│   ├── hooks/
│   ├── auth/                 ✚ # LoginPage, InvitePage, ForcedPasswordChangePage, PinGate
│   ├── portfolio/            ✚ # PortfolioPage (+ overview blocks), TransactionDialog-consumers,
│   │                           #   CustomInvestmentDialog, ValuePointEditor, switcher
│   ├── workboard/            ✚ # WorkboardOverview, WatchlistPage,
│   │   └── conglomerates/    ✚ #   list, BuilderPage, DetailPage, calculator
│   ├── assets/               ✚ # AssetsOverview, SearchPage, AssetDetailPage, category stubs
│   ├── social/               ✚ # FriendsPage, SharedWithMePage, SharedPortfolioView,
│   │                           #   MySharedItemsPage, stubs (Ideas, PublicProfile)
│   └── settings/             ✚ # SettingsLayout + Account/Notifications/Security
│                               #   + placeholder pages (Imports, Connections, Backups, ApiAccess)
```

**Mechanical move table (P0):**

| From (`apps/web/src/user/…`) | To |
|---|---|
| `pages/LoginPage.tsx`, `pages/InvitePage.tsx`, `pages/ForcedPasswordChangePage.tsx` | `auth/` |
| `pages/PortfolioPage.tsx` (+ its `.test`) | `portfolio/` |
| `pages/WorkboardPage.tsx` (+ test) | `workboard/` (becomes WatchlistPage; new thin WorkboardOverview) |
| `pages/SearchPage.tsx`, `pages/AssetDetailPage.tsx` (+ tests) | `assets/` |
| `components/CustomInvestmentDialog.tsx`, `components/ValuePointEditor.tsx` | `portfolio/` |
| `pages/placeholders.tsx` | dissolved into per-section Coming Soon pages using `ui/ComingSoon` |

`components/TransactionDialog.tsx`, `AssetSearchBox`, `CmdKPalette`, `Dialog`, `ui.tsx` stay in `user/components/` (used across sections). Imports updated mechanically; tests move with their files.

### 7.4 Component inventory (the reusable core)

`AssetSearchBox` · `CmdKPalette` · `PriceChart` (ranges, area/step, benchmark overlay, future LIVE mode slot) · `Sparkline` · `AllocationDonut` · `WeightRow` (input+slider+lock) · `SumPill` · `BudgetCalculator` · `TransactionDialog` (single & bulk) · `ValuePointEditor` · `NotificationBell` · `MoneyText` · `StatCard` · `EmptyState` · `ComingSoon` · `PortfolioSwitcher` (placeholder) · `SubNav` (per-section tabs).

### 7.5 API client

Generated from `packages/contracts` (zod → typed fetch wrapper): fully typed end-to-end, errors normalized to the API envelope, one place for auth/redirect/429-toast policy, `credentials: 'include'` against the configured API origin. The same package is what a future mobile app imports.

---

## 8. API Reference (V1 surface)

Conventions: base `/api/v1`, JSON, camelCase; errors `{ error: { code, message, details? } }`; cursor pagination `?limit&cursor` where lists grow; all routes require a session unless marked **P** (public). Versioning: additive-only within v1; breaking ⇒ `/api/v2`. The whole surface is documented at `/docs` (§6.13).

| Area | Endpoints |
|---|---|
| Auth | **P** `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/change-password` · `POST /auth/pin/verify` · `PUT/DELETE /auth/pin` (enable/change/disable) · **P** `GET /auth/invite/:token` · **P** `POST /auth/accept-invite` |
| Search | `GET /search?q=` (local catalog, §6.2) |
| Assets | `GET /assets/:id` · `GET /assets/:id/quote` · `GET /assets/:id/history?range=` |
| Workboard | `GET /workboard` · `POST /workboard` `{assetId}` · `DELETE /workboard/:itemId` · `PATCH /workboard/reorder` |
| Conglomerates | `GET /conglomerates` · `POST /conglomerates` · `GET/PATCH/DELETE /conglomerates/:id` · `PUT /conglomerates/:id/positions` (bulk replace — autosave) · `POST /conglomerates/:id/activate` · `GET /conglomerates/:id/backtest?range&benchmark` · `POST /backtest/preview` · `POST /conglomerates/:id/allocate` `{budgetEur, mode, step?}` |
| Portfolios | `GET /portfolios` (V1: the default) · `GET /portfolios/:id` (holdings+totals) · `PATCH /portfolios/:id` (name, **visibility**) · `GET /portfolios/:id/history?range=` · `GET /portfolios/:id/transactions?cursor=` · `POST /portfolios/:id/transactions` (single or bulk buy-flow) · `PATCH/DELETE /portfolios/:id/transactions/:txId` · `POST /custom-assets` · `PATCH/DELETE /custom-assets/:id` · `GET/PUT /custom-assets/:id/value-points` |
| Social | `GET /social/friends` · `DELETE /social/friends/:userId` · `GET /social/requests` (in/out) · `POST /social/requests` `{usernameOrEmail}` · `POST /social/requests/:id/accept` · `POST /social/requests/:id/decline` · `DELETE /social/requests/:id` (cancel) · `GET /social/shared-with-me` · `GET /social/shared-with-me/portfolios/:id` (read-only, friendship-scoped) |
| Notifications | `GET /notifications?cursor=` · `POST /notifications/mark-read` `{ids|all}` |
| Settings | `GET/PATCH /settings/notifications` · `GET /settings/security` |
| Admin | `GET /admin/users` · `POST /admin/users` · `PATCH /admin/users/:id` · `POST /admin/users/:id/reset-password` · `DELETE /admin/users/:id` · `GET /admin/users/:id/emails` (email log) · `GET/POST /admin/invites` · `POST /admin/invites/:id/revoke` · `GET/PATCH /admin/settings` (global app settings) · `GET /admin/stats` · `GET /admin/audit?cursor=` · `GET /admin/emails?cursor=` |
| Meta | **P** `GET /health` · **P** `GET /docs` · **P** `GET /openapi.json` |

Post-v1 additions (designed): `/alerts`, share links (`/s/:token`), conglomerate export/import, `/settings/api-keys`, WebSocket `/ws`.

---

## 9. Background Jobs & Domain Events

| Job (BullMQ) | Schedule | What it does |
|---|---|---|
| `prices.refreshDaily` | nightly 03:00 Europe/Vienna | Upsert yesterday's daily closes into `price_history` for every asset referenced anywhere + all FX pairs in use. |
| `prices.backfill` | on demand | First use of an asset: fetch max-range daily history (queued, ~1 asset/sec — polite). |
| `fx.refreshSpot` | hourly | Refresh current FX rates for `services/currency`. |
| `catalog.enrich` | on demand | Background provider search for catalog misses (§6.2) + metadata refresh; budgeted per §5.3. |
| `notifications.dispatch` | on event | Fan out a domain event to the user's enabled channels; every email attempt writes `email_log`; per-channel retry 3× exponential. |
| `alerts.evaluate` | post-v1 | Every 1 min; spec preserved in §14. |

Retries: 3 attempts, exponential backoff, dead-letter list visible in admin stats. All schedules live in code.

**Domain events** (typed, `events/`): `notification.created` · `friend.request` · `friend.accepted` · `portfolio.shared` · `portfolio.changed` · `quote.updated` · `conglomerate.updated` (+ `alert.triggered` post-v1). Producers: services/jobs. Consumers: notification dispatcher (V1), realtime gateway (post-v1) — new consumers subscribe without touching producers.

---

## 10. Security & Privacy

- **Closed by default:** every route requires a session except login/invite/health/docs; admin routes require the admin account kind; user routes reject admin sessions (§3). Object access is always ownership-scoped in repositories (`WHERE owner_id = session.user` — no IDOR by construction); social reads additionally require live friendship + visibility (§6.9).
- **Passwords & PIN:** argon2id (memory 64 MB, iterations 3, parallelism 1) for both; session rotation on login; all-session invalidation on password change/disable. Sessions: 30 days, renewed by login or PIN verify (§6.1). API keys (post-v1): hashed at rest, never expire, revocation-only, never logged.
- **Cookies/CSRF/CORS:** httpOnly + `SameSite=Lax` + `Secure`; state-changing requests require `X-Requested-With: BetterTrack`. The API's CORS allowlist is exactly the derived `WEB_ORIGIN` + `ADMIN_ORIGIN` (§11) with credentials; all origins share one registrable domain (or one host in ports mode), keeping `Lax` cookies flowing. Strict `Origin` check on state-changing requests (and the future socket handshake).
- **Headers:** helmet with strict CSP (self + the API origin for connect-src; no third-party assets — fonts/icons bundled).
- **Validation:** every request body/query parsed by the shared zod schema; unknown fields rejected.
- **Progressive rate limiting** (Redis, replaces the old fixed-window blocks — owner directive #79):
  - **Principle:** normal use is never limited; bursts get short pauses; only sustained abuse gets long cooldowns. Limits reset quickly after good behavior (escalation level decays after ~15 min without violations).
  - **General API:** generous steady-state allowance (≈ the current 4500/15 min/user); on exceeding it: cooldown **10–30 s**, then per repeated violation **1 min → 3 min → 10 min** (cap). 429 responses carry `retryAfter`; the SPA shows the existing toast.
  - **Login (stricter, security-sensitive):** ~**10 failed attempts → 30 s cooldown**, next batch → **a few minutes**, escalating to **10 min+** for persistent hammering; per-IP and per-account tracked separately. PIN verify uses the login schedule.
  - Search keeps its own modest per-user budget; admin endpoints get the general schedule.
- **Share/invite tokens:** ≥ 128-bit CSPRNG, url-safe, constant-time compare, revocable, never logged.
- **Outbound safety:** provider HTTP fixed to known hosts (no user-supplied URLs ⇒ no SSRF surface); secrets only via env; `pnpm audit` in CI.
- **Privacy:** PII = email only; user deletion cascades all data incl. friendships; email log stores metadata, never bodies; no analytics/trackers; logs (pino, JSON) exclude bodies and tokens. Backups: nightly `pg_dump`, 14-day rotation, restore procedure in README.
- **Disclaimers (footer + asset pages):** market data comes from an unofficial source and may be delayed or inaccurate; BetterTrack is not investment advice.

---

## 11. Configuration & Environments

**Principle: the app must be flexible to set up anywhere.** One global config drives the whole topology; every name and port is overridable; nothing origin-shaped is hardcoded.

| Variable | Example / default | Notes |
|---|---|---|
| `BT_DOMAIN` | `example.at` | The single global domain |
| `BT_MODE` | `subdomains` \| `ports` | Deployment mode (§4.6) |
| `BT_SUB_API` / `BT_SUB_WEB` / `BT_SUB_ADMIN` | `api` / `web` / `admin` | Subdomain names (subdomains mode) |
| `BT_PORT_API` / `BT_PORT_WEB` / `BT_PORT_ADMIN` | `3000` / `8080` / `8081` | Host ports (always used for binding; the public origin in ports mode) |
| `BT_API_ORIGIN` / `BT_WEB_ORIGIN` / `BT_ADMIN_ORIGIN` | *(derived)* | Escape hatch: explicit overrides beat derivation for exotic setups |
| `DATABASE_URL` · `REDIS_URL` | `postgres://bt:…@db:5432/bettertrack` · `redis://redis:6379` | |
| `SESSION_SECRET` | 64 random bytes | rotatable (comma-separated array) |
| `SMTP_HOST/PORT/USER/PASS/FROM` | `smtp.gmail.com` / `465` / gmail address / **app password** / `BetterTrack <addr@gmail.com>` | Gmail app password is the documented preset (§6.10); any SMTP works; empty ⇒ email channel disabled, app still runs, sends logged as `suppressed` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | seeds the first admin on first boot only |

**Origin derivation** (in `config/env.ts`, single source of truth consumed by CORS, cookies, link generation, the SPA runtime config and nginx templating):
- `subdomains` mode: `https://{BT_SUB_X}.{BT_DOMAIN}` for each service (TLS assumed at the front proxy).
- `ports` mode: `http(s)://{BT_DOMAIN}:{BT_PORT_X}` — one hostname (may be an IP or `localhost`), no subdomains, everything separated by port.

**nginx layout** (`infra/nginx/`): templated at container start from the same env.
- *Subdomains mode:* one nginx with three `server` blocks by `server_name` — `web.*` serves the SPA (user runtime config), `admin.*` serves the same SPA (admin runtime config), `api.*` proxies to `api:3000`.
- *Ports mode:* the same three server blocks keyed by `listen` port instead of hostname.
- In both modes the SPA server blocks inject `window.__BT__` (app kind + API origin) via a generated `config.js` — one web image serves every topology.

**Dev:** `docker compose -f infra/docker-compose.dev.yml up` (db+redis) → `pnpm dev` (vite + tsx watch + worker); defaults to ports mode on `localhost`. Migrations `pnpm db:migrate`; seed creates the first admin + a demo user. **Prod:** `docker compose up -d` in `infra/` — five services (§4.6); deploy = build, migrate, restart.

---

## 12. Testing & Quality

- **Domain layer = the testing crown jewels.** Table-driven Vitest suites for `allocation` (incl. the §6.7 worked example, unreachable weights, budget edges, fractional steps), `backtest` (clipping, FX conversion, carry-forward, drawdown math), `holdings` (avg-cost sequences, oversell rejection) — and post-v1 `alertEval`. Milliseconds-fast, gate every commit.
- **Service/API tests:** Supertest against test Postgres (PGlite fast path / real Postgres integration job), providers mocked with recorded fixtures — auth flows incl. account-kind separation and PIN, ownership scoping, invite lifecycle, **friendship/visibility privacy boundaries** (revocation closes access immediately; non-friends get 404), registration-mode enforcement, progressive rate-limit schedules (violation → cooldown → escalation → decay), search-index ranking and coalescing (concurrent misses ⇒ one upstream call).
- **Contracts:** zod schemas type-checked against handlers; the OpenAPI generator fails CI when a route is undocumented (§6.13).
- **E2E (thin):** one Playwright happy path — login → search (local) → watch → build conglomerate → allocate → add to portfolio → enable friend sharing → second account accepts request and sees the portfolio. Nightly, not per-commit.
- **CI (GitHub Actions):** install → typecheck → lint → unit/service tests → build web + api images. Tags push images.

---

## 13. Milestones — the V1 build order

Encodes the owner's V1 definition (#79): **V1 = BetterTrack Core + Tiny Friend Sharing** — all five tabs exist and look final; some surfaces are designed Coming-Soon placeholders. Each phase ends in something usable; "done" = acceptance criteria met + tests green. Ordering is pragmatic given what already exists (auth, admin, providers/caching v1, search v1, asset page, workboard watchlist, portfolio, backtest engine, jobs — built; conglomerate CRUD in flight).

| Phase | Scope | Done when |
|---|---|---|
| **P0 — v2 shell & restructure** | Final 5-tab navigation + profile dropdown + subnavs; route tree per §7.2 with `ComingSoon` placeholders for every future surface; file moves per §7.3 move table (mechanical); login card top-middle-ish; root docs tidy → `docs/` (§4.2); README pointers updated | The app looks like final BetterTrack: every tab and subnav opens, placeholders say Coming soon, all tests still green after the moves |
| **P1 — Asset catalog, local search & cache rework** | Catalog indexes on `assets` (tsvector + pg_trgm) + seed list; local-first `/search` with ranking + background provider enrichment (`catalog.enrich`); caching hardening to §5.3: coalescing everywhere (in-process + Redis lock), negative caching, serve-stale, per-provider budgets | "bayer", "bay", "bayr" all return BAYN.DE instantly with zero synchronous provider calls; concurrent identical misses produce exactly one upstream fetch (test); provider outage degrades to stale, never errors |
| **P2 — Identity, sessions & topology** | Admin/user account-kind split (§3: admin = management-only, mutual endpoint rejection, no default portfolio, seeds updated); 30-day sessions + PIN option (§6.1); progressive rate limiting (§10); topology env scheme + derived origins + nginx templates for both modes + admin-origin serving + runtime SPA config (§11) | Admin session cannot reach any user endpoint (test) and vice versa; PIN renews the 30-day window; limiter follows the escalation/decay schedule (test); the stack boots in subdomains mode and ports mode from env alone |
| **P3 — Portfolio v2 & multi-portfolio prep** | `portfolio_id`-scoped API (`/portfolios/:id/…`) with one auto-created default; switcher placeholder; overview page blocks: totals, performance chart, holdings, **top winners/losers**, donuts, recent transactions, quick add; `visibility` flag + settings/privacy toggle (flag only — consumed in P5) | Existing portfolio flows work through the scoped API; overview shows winners/losers; a second portfolio row created in SQL appears in `GET /portfolios` without code changes |
| **P4 — Workboard playground: Conglomerates + calculator** | Workboard subnav + overview; finish conglomerate CRUD + **Builder** (locks/auto-balance/normalize/autosave/live preview §6.5) + detail with backtest UI (§6.6); `domain/allocation` + calculator UI + bulk buy-flow (§6.7); Coming-Soon stubs (Comparisons, Saved Ideas, sharing) | Build 13/40/47 Pepsi/Coke/Bayer, activate, 5Y backtest vs S&P 500 with clipping notice; 1000 € → buy list ≤ budget with deviation table → recorded in portfolio in two clicks |
| **P5 — Social minimal** | `friend_requests` + `friendships` schema; request by username/email (no enumeration), accept/decline/cancel/remove; Friends page; portfolio `visibility=friends` consumption: Shared With Me + read-only friend portfolio view; My Shared Items | Two-account flow works end-to-end; privacy tests: non-friends 404, visibility-off 404, unfriending instantly closes access |
| **P6 — Notifications & the email log** | Notification bell + unread + mark-read (REST refetch; no socket); `notification_settings` toggles; types `friend.request`/`friend.accepted`/`portfolio.shared` wired to P5 events; Gmail app-password SMTP preset; `email_log` on every send; admin per-user + global email log views | A friend request produces a bell item and a logged email within seconds; admin sees that user's email log; SMTP-less deploys log `suppressed` and never crash |
| **P7 — Settings section** | Settings subnav per §6.11: Account (incl. privacy/sharing toggles), Notifications, Security (sessions info, PIN management) implemented; Imports & Exports, Connections, Backups, API Access as designed placeholders; profile dropdown finalized | Every settings subpage is reachable; implemented pages function; the rest render designed Coming-Soon states |
| **P8 — Admin global settings & registration modes** | `app_settings` + admin Settings page; registration-mode selector (closed enforced; invite-token/approval/open visible, disabled, Coming soon) with enforcement reading the setting from day one; beta-mode placeholder; admin overview cards refresh (emails 24 h, queue health) | Settings persist and audit-log; registration behavior provably follows the stored mode (closed blocks a hand-crafted register call); selector shows all four modes |
| **P9 — API `/docs`** | OpenAPI 3 generation from contracts; `GET /openapi.json` + human-readable `GET /docs` on the API origin; CI coverage gate (every route documented) (§6.13) | `api.<domain>/docs` renders complete, accurate endpoint docs; CI fails on an undocumented route |
| **P10 — Polish, e2e & v1 gate** | Empty states/skeletons/error boundaries sweep; responsive pass; disclaimers; deploy guide for **both** topology modes; backups verified; Playwright e2e (§12); pre-release Fable review of the whole branch | Fresh invite → first stock → conglomerate → buy list → friend share, on a phone browser, without confusion; `docker compose up` works from the README alone in either mode; e2e green |

**V1 scope summary:** IN V1 = everything marked ✔ above. **Coming-Soon placeholders** (visible, routed, designed): multi-portfolio UI, portfolio widgets/custom layout, broker CSV imports, watchlist/conglomerate sharing, comparisons, saved ideas, asset category browsers, Live Mode, social Ideas/public profiles, settings Imports/Connections/Backups/API-Access, non-closed registration modes, Invite-Others/Share-Profile menu items. **Post-v1 (no placeholder needed):** alerts + evaluator, realtime gateway, share links, JSON export/import, API keys/OAuth, 2FA, Firebase/mobile, finance/expense tracking (§14).

**After V1:** when all P0–P10 acceptance criteria are met, the factory planner creates a **"check v1"** issue labeled `awaiting-owner` (not `autopilot`) and **pauses feature planning for owner feedback** — per the owner's directive, it may meanwhile queue only bug-fix/hardening work, never new §14 features.

---

## 14. Future Features

The intentional parking lot — scoped out of V1, designed-for in V1. Roughly ordered by leverage; ⚡ = nearly free thanks to the architecture.

**First picks after V1**
- **Price alerts + evaluator** — schema and notification fan-out already exist. Rule kinds `price_above/below`, `pct_up/down_from_ref` (ref captured at creation), `pct_day_up/down`; evaluated every minute against cached quotes; one-shot (fire once → `triggered`, manual re-arm) or `repeat` (24 h cooldown); idempotency key per (alert, trigger window). Workboard alerts panel + asset-page inline alerts.
- **Realtime gateway** (§4.5) — socket push for notifications, quotes, shared views; the event bus is already in place.
- **Live Mode v1** — the §6.3 design: shared per-asset polling loop → Redis ring buffer → `asset:{id}` fan-out; windows 1 m–12 h; auto-stop.
- **Conglomerate sharing** — share links (≥128-bit token URL, live read-only view + clone, revocable), sharing to friends, JSON export/import incl. the legacy `conglomerate.py` prototype format (`{version:1, conglomerates:{…holdings:[{ticker,name,weight}]}}`).
- **Multi-portfolio UI** — create/rename/archive portfolios, switcher, per-portfolio pages; the data model ships ready in V1.

**Sharing & Social**
- Public profiles & public links (customizable: whole portfolio, selected parts, conglomerates, ideas — freeze-shot or live); shared **editable** portfolios (permission levels: read-only / edit / manage); ideas (shareable Workboard analyses + "suggest this asset" messages to friends); later: comments/reactions/groups — always gated by explicit opt-in privacy.

**API access as a product** (§6.13)
- API keys / personal access tokens with scopes (never expire, revoke-only), OAuth apps, per-key rate limits and audit trail; outbound user-defined webhooks. The smart-fridge dashboard becomes possible here.

**Portfolio & finance**
- Broker CSV imports (Trade Republic, George, Flatex, IBKR mappers); FIFO/tax-lot accounting + realized P/L & dividend reports (AT tax view); dividends as cash-flow transactions; daily snapshot table; benchmark-vs-portfolio overlay; per-user base currency (currencyService is already parameterized).
- **Buy-price → date lookup** (owner idea, 2026-07-02): in the "price + invested amount" transaction entry mode (#109), optionally search the asset's price history backwards for the most recent time it traded at the entered buy price and suggest that as the transaction date (with a hint when the price crossed that level multiple times).
- **Personal finance / expense tracking** (larger future direction): upload bank-transaction CSVs → categorized spending analytics (by category/month), budgets, personal finance dashboard; later bank APIs and automatic import.

**Market data & assets**
- ⚡ Gold/commodities (`XAUEUR=X`, `GC=F`) and crypto (`BTC-EUR` or a CoinGecko provider) — register symbols or add a provider file; category browse pages fill in.
- Provider failover chains; earnings calendar; per-asset news.

**Conglomerates & Workboard**
- Rebalanced backtest mode (monthly/quarterly/yearly); conglomerate-vs-conglomerate comparisons; what-if sandboxes on shared views; nested conglomerates; multiple named watchlists; saved strategy ideas.
- **Full-window backtest for late-listed constituents** (owner idea, 2026-07-04): when a conglomerate holds an asset younger than the requested window (the "SpaceX case": listed 18 months ago, backtest is 5Y), today the engine clips the window to the youngest constituent (§13 P4 notice), silently turning a 5Y comparison into an 18-month one. Instead offer a backtest **mode selector** that runs the full requested window with a user-chosen rule for the pre-listing period. Example throughout: 25% Bayer / 25% SpaceX / 25% Coca-Cola / 25% BMW, 5Y, SpaceX listed 18 months ago.
  1. **Clip to common history** (current behavior, kept): window starts at the youngest constituent's first trading day, with the existing notice.
  2. **Cash until listing:** each constituent's share is invested from window start *if it exists*; a not-yet-listed asset's share sits as uninvested cash (0% return) until its first trading day, then is invested at that day's price. (75% works from day one, SpaceX's 25% waits 3.5Y.) Mirrors "I'd have kept that money aside until it went public."
  3. **Redistribute until listing:** a not-yet-listed asset's share is split **equally** among the already-listed constituents until its first trading day; on that day the portfolio **rebalances to the target weights**. (Bayer/Coca-Cola/BMW at ~33.3% each for 3.5Y, then an entry-day rebalance to 25/25/25/25.) Mirrors "I'd have invested everything in the rest, then rebalanced when it arrived."
  - **Design notes:** equal split is the owner default (a proportional variant may be offered later; state the chosen rule in the UI notice). Apply the rule per late asset independently — each listing date is an investment event (cash mode) or a rebalance event (redistribute mode). Chart affordances: vertical marker at each entry date ("SpaceX enters"), notice text adapts to the chosen mode instead of the clipping message, and in cash mode the idle-cash portion is made visible (subtle band or an "avg. uninvested: X%" stat). Benchmark (S&P 500) always runs the full window — in cash mode the idle-cash drag is real and intended, the honest comparison being asked for. Entry pricing = first available close on/after the listing date, FX/dividends unchanged. **Shares the rebalance primitive with the Rebalanced backtest mode above** (an entry-day rebalance is a special case of scheduled rebalancing — build the primitive once). Out of scope for this idea: scheduled periodic rebalancing itself (only the shared primitive), delisting/merger handling (asset stops existing mid-window — worth a code note), and any change to portfolio real-holdings graphs (backtest-only).

**Notifications**
- ⚡ Telegram/Discord channels (implement `NotificationChannel`, register, add settings fields); digest mode; quiet hours; web-push (PWA).

**Mobile & clients**
- **Firebase/mobile future architecture:** a native/React-Native app speaks the identical REST API; **Firebase Cloud Messaging** becomes a new NotificationChannel for phone push; no backend rewrite — this is the entire point of API-first. PWA (installable, offline shell) first; kiosk/TV read-only dashboard.

**Accounts & security**
- **2FA (TOTP) — planned** (§6.1) + passkeys; Google login; self-service password reset by email; session manager UI ("log out that device"); full account data export; Google Drive backups.

**Admin & ops**
- Activate invite-token / approval / open registration modes (§6.12); full feature flags; announcements; usage analytics; bull-board; Sentry; Prometheus/Grafana.

**Speculative**
- AI insights ("71% US tech — concentration note"); natural-language conglomerate builder; i18n DE/EN; light theme; custom widget builder for the Portfolio overview.

---

## 15. Open Items (owner to provide — none block development)

1. Domain name + server for deployment (both topology modes run anywhere meanwhile).
2. The Gmail account + app password for the email channel (stays gracefully disabled/suppressed until set).
3. Final accent color / logo direction (wordmark + favicon exist; refinement tracked in issues).
4. Exact Live Mode window set (1 m … 12 h are the working defaults, adjustable later).

## 16. Decision Log

| Date | Decision | Why |
|---|---|---|
| 2026-06-12 | Stack: React+Vite SPA + Express API, TS monorepo, Postgres, Redis, Docker | Owner choice — "proper big scale", matches existing experience |
| 2026-06-12 | Closed accounts; admin-created **and** invite links; email mandatory | Owner decision |
| 2026-06-12 | Notification channels abstracted; v1 = in-app + email (email primary) | Owner decision; Telegram/Discord later as plug-ins |
| 2026-06-12 | EUR base + FX conversion; per-user base deferred to Future Features | Owner decision |
| 2026-06-12 | Market data: Yahoo Finance behind the provider abstraction | Free, EU coverage, proven in the conglomerate.py prototype; swappable by design |
| 2026-06-13 | Strict 3-layer split: static SPA · API/business core · data; push via WebSocket; API-first for a future mobile app | Owner requirement ("display/business/data, app runs on the user's PC, SignalR-style communication") |
| 2026-06-13 | Renamed PortfolioMan → **BetterTrack** | Owner decision |
| 2026-06-15 | While Claude Fable 5 is unavailable, the build factory builds T1 (`tier:fable`) work on **Opus at max reasoning**, reverting to Fable automatically when it returns | Owner authorization — Fable access is gated ("Mythos"); the P1 provider/caching/currency keystone must not block the whole pipeline. Routing rule 3 is relaxed for the duration of the outage only (CLAUDE.md rule 7) |
| 2026-06-16 | A disabled account that logs in with the **correct** password gets a distinct `ACCOUNT_DISABLED` (403, "account suspended") instead of the generic `INVALID_CREDENTIALS`. The status is revealed **only after** the password is verified correct — wrong-password and unknown-user paths stay generic — so it is not a user-enumeration oracle | Owner authorization (chris-dev-at) — a suspended user authenticating correctly should understand *why* they can't get in rather than seeing a wrong-password message. Safe because the reveal sits after the password check (PROJECTPLAN.md §6.1) |
| 2026-06-16 | Relax the §6.1/§10 rate limits (all centralized in `apps/api/src/config/env.ts`): general API per-user 600 → **4500/15 min**, login 5 → **25/min/IP**, admin 120 → **600/15 min**; per-account throttle `accountFailuresPerHour` 10 → **20**, `lockoutThreshold` 10 → **20**, lockout **15 min → 5 min** | Owner authorization (chris-dev-at) — the original general limiter (~40 req/min) tripped 429s during normal logged-in use as rapid tab switching / multi-tab TanStack-Query refetches exceeded it. Spam/abuse protection relaxed substantially while keeping a real (if lenient) brute-force guard. Architecture, Redis store, and search 60/min/user limit unchanged |
| 2026-07-01 | Fable restored; outage fallback reverted (see docs/FableBackExecute.md) | Owner |
| 2026-07-01 | **Plan v2 rework per owner issue #79 + session directives** (new nav/product structure, multi-portfolio, Social, config topology, admin/user split, API docs) | Owner directive #79 is the new product truth: 5-tab structure, multi-portfolio data model, minimal friend sharing, local search index, caching/coalescing keystone, Live Mode design, expanded Settings, Gmail email + email log, admin global settings + 4 registration modes, 30-day sessions + PIN + progressive rate limits, API access as a product feature; session directives added the subdomains/ports deployment topology, the management-only admin account kind, and the V1 `/docs` page. Superseded rate-limit rows above are replaced by the §10 progressive scheme |
| 2026-07-03 | **Allocate response (`allocatePositionSchema`) extended with `nativePrice` + `currency`** (`packages/contracts/src/conglomerate.ts`, `apps/api/src/services/conglomerate/conglomerateService.ts`), out of issue #138's stated scope (which put the allocate contract/endpoint out of scope and said to flag-not-edit) | Building the Invest Calculator buy-flow (#138, PR #150) surfaced a real currency bug: the bulk prefill recorded the EUR-converted `costEur/qty` into a transaction's `price`, which `domain/holdings.ts` treats as **native-currency** and re-converts by `asset.currency` — silently double-converting the cost basis of any non-EUR position (e.g. USD-quoted NVDA/GOOGL). Reverting to a `costEur/qty` prefill would ship that bug, so the allocate response now carries each position's native `price` + ISO-4217 `currency` (read from the *same* cached quote already used for the EUR conversion — no second fetch, no drift). Additive-only. Ratified by Chief of Development 2026-07-03; issue re-tiered sonnet→opus (contracts/endpoint is T2, adjacent to the §5.3 currency keystone); tracked in #152. An independent tier:opus review of the exact diff found it safe/correct as-is |
