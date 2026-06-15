# BetterTrack — Project Plan

| | |
|---|---|
| **Status** | Approved blueprint — implementation not started |
| **Last updated** | 2026-06-13 |
| **Owner** | chris-dev-at |
| **Repo** | https://github.com/chris-dev-at/BetterTrack |

This document is the single source of truth for what BetterTrack is and how it is built. It is written so that anyone (including future-you) can read it and know exactly how the app should work, down to data shapes and algorithms. Sections 1–13 describe **v1 scope**. Everything beyond bare-core functionality lives in **Section 14 — Future Features**, deliberately kept rich so features can be picked up later without re-designing.

---

## 1. Vision & Goals

BetterTrack is a self-hosted web application for watching stocks, building **Conglomerates** (your own ETF-style weighted baskets of stocks), and tracking your real **Portfolio** — including investments that exist nowhere else (your car, your house, an unlisted stock).

**Core promises:**

1. **Watch** — search any stock, put it on your Workboard, chart it, set alerts (price hit, ±X%).
2. **Compose** — build Conglomerates with percentage weights, see how the basket would have performed historically, share them with others by live link or JSON file.
3. **Plan** — give a Conglomerate a budget ("1000 €") and get a concrete buy list (whole shares or fractional) that never overshoots the budget.
4. **Track** — record real buys/sells with amount, price and time; see value, profit/loss and history of everything you own, market-listed or not.
5. **Private** — closed user group. No public signup. Accounts exist only because the admin (you) created or invited them.

**Non-goals (v1):** BetterTrack is not a broker (no order execution), gives no investment advice, has no public/SEO pages, and does not aim for real-time tick data (LIVE view is a Future Feature).

**Success criteria for v1:** an invited user can log in, find BAYN.DE and NVDA, watch them, build a 30/60/10 Conglomerate, backtest it over 5 years, turn 1000 € into a buy list, add those buys to their Portfolio next to their house as a custom investment, and get an email when Bayer drops 20%. The admin can manage every account from a separate admin area. The server does almost nothing while nobody interacts — all UI runs in the user's browser.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Asset** | Anything trackable with a price/value over time. Market assets (stocks, ETFs, indices, FX pairs) come from a data provider; **custom assets** (house, car, unlisted stock) get their values from the user. One unified concept — everything downstream (charts, portfolio math, backtests) treats them identically. |
| **Provider** | A pluggable source of asset data implementing the `AssetProvider` interface (search, quote, history, metadata). v1: `yahoo` (market data) and `manual` (custom assets). |
| **Quote** | Latest known price of an asset + day change, currency, timestamp. |
| **Workboard** | A user's watch area: the watchlist of assets they observe, their alerts, and quick access to their Conglomerates. Watching ≠ owning. |
| **Alert** | A rule on an asset (price above/below X, ±X% from reference, ±X% on the day) that fires a notification when met. |
| **Conglomerate** | A named basket of assets with percent weights summing to 100. The user's "own ETF". Belongs to one account; shareable read-only. |
| **Position** | One entry of a Conglomerate: asset + weight percent. |
| **Backtest** | Historical performance of a Conglomerate, computed from daily closes as a weighted buy-and-hold index. |
| **Invest Calculator** | Turns (Conglomerate + budget) into a concrete buy list, whole-share or fractional, never exceeding budget. |
| **Portfolio** | A user's record of real ownership, derived from transactions. |
| **Transaction** | One buy or sell: asset, quantity, price, fee, timestamp. |
| **Custom investment** | A user-created asset with manually entered **value points** ("worth 250 000 € on 2024-01-01, 262 000 € on 2025-06-01"). Values carry forward between points. |
| **Share link** | Tokenized URL to a live read-only view of a Conglomerate. Always shows current state; revocable; viewer needs an account. |
| **Notification channel** | A pluggable delivery mechanism for notifications. v1: in-app + email. Telegram/Discord/etc. are plug-ins added later. |
| **Base currency** | Currency everything is converted to for totals/charts. v1: fixed to EUR (per-user setting is a Future Feature). |

---

## 3. Users & Access Model

- **User** — created by the admin (directly or via invite link). Has email (required), username, password. Uses the entire app. Cannot see other users' data except Conglomerates explicitly shared with them by link.
- **Admin** — you. Logs in at a **separate admin area** (`/admin`) with its own login screen and layout, visually and navigationally distinct from the app. Manages accounts: create, invite, disable, reset password, delete. The admin account is for administration; use a normal user account for actual tracking (keeps the mental model and permissions clean). Admin cannot browse users' portfolios (privacy stance — stated deliberately).
- **Nobody else.** Every API route and every page except login/invite-accept requires a session. There is no registration page and no self-service password reset in v1 (admin resets passwords; email-based self-reset is a Future Feature).

**Email is mandatory on every account** — it is the identity for invites, password handling and the primary alert channel.

---

## 4. System Architecture

### 4.1 Three layers, strictly separated

```
┌────────────────────────────────────────────────────────────┐
│ DISPLAY LAYER — runs on the user's machine                 │
│   BetterTrack Web (React SPA, static files)                │
│   future: mobile app, CLI, widgets — all equal API clients │
└──────────────▲─────────────────────────▲───────────────────┘
               │ REST /api/v1 (JSON)     │ WebSocket (push)
┌──────────────┴─────────────────────────┴───────────────────┐
│ BUSINESS LAYER — BetterTrack Core (Node/Express service)   │
│   HTTP API · Realtime gateway · Services · Domain logic    │
│   Notifications · Jobs/Scheduler · Domain events           │
└──────▲──────────────▲──────────────▲───────────────────────┘
       │              │              │ AssetProvider interface
┌──────┴──────┐ ┌─────┴─────┐ ┌──────┴──────────────────────┐
│ DATA LAYER  │ │           │ │ External market data        │
│ PostgreSQL  │ │   Redis   │ │  yahoo (v1) · manual (v1)   │
│ (records)   │ │cache/queue│ │  gold/crypto providers later│
└─────────────┘ └───────────┘ └─────────────────────────────┘
```

**Principles (these are rules, not suggestions):**

1. **The display layer is dumb.** The SPA is a folder of static files (HTML/JS/CSS) served with long-lived cache headers. After load, it runs entirely in the user's browser — the server renders nothing. Server cost per user ≈ API calls only.
2. **API-first.** Every feature is an API endpoint first; the web app is merely the first consumer. A future phone app uses the exact same `/api/v1` and WebSocket — zero backend changes.
3. **All logic lives in the business layer.** The SPA never computes anything authoritative (no portfolio math, no allocation math in the browser — it only displays results). This guarantees a mobile app gets identical numbers.
4. **Push over poll.** A WebSocket gateway (SignalR-style: rooms, auto-reconnect) pushes notifications, alert triggers and data-change signals to connected clients instead of clients hammering the API. The app must remain fully functional with the socket down (REST fallback).
5. **Data sources are pluggable.** Nothing outside `providers/` knows Yahoo exists. Swapping/adding providers (gold API, crypto, another stock source) touches one directory.
6. **Modular monolith.** One deployable backend with strict internal module boundaries (below) — big-app structure without microservice overhead. If a module ever needs to scale out (e.g. jobs), the seams already exist.

### 4.2 Repository layout (pnpm monorepo, TypeScript everywhere)

```
bettertrack/
├── apps/
│   ├── web/                  # DISPLAY: React SPA
│   └── api/                  # BUSINESS: Express service (+ worker entrypoint)
├── packages/
│   ├── contracts/            # Shared zod schemas, TS types, typed API client
│   └── config/               # Shared tsconfig, eslint, prettier
├── infra/
│   ├── docker-compose.yml    # prod topology
│   ├── docker-compose.dev.yml# db+redis only, apps run locally
│   ├── nginx/                # static hosting + /api,/ws proxy config
│   └── .env.example
├── PROJECTPLAN.md            # this file
└── README.md
```

`packages/contracts` is the keystone of layer separation: every request/response body is a zod schema defined once, used by the API for validation, by the SPA for types, and later by the mobile app. The API and the client can never drift apart silently.

### 4.3 Backend internal structure (`apps/api/src/`)

```
http/           # Express routes/controllers — THIN: parse → call service → respond
realtime/       # Socket.IO gateway: auth handshake, rooms, event fan-out
services/       # Business orchestration: authService, workboardService,
                #   conglomerateService, portfolioService, alertService,
                #   notificationService, adminService, sharingService
domain/         # PURE functions, no I/O: allocation, backtest, holdings math,
                #   alert evaluation. 100% unit-testable, the most-tested code.
data/           # Drizzle schema + repositories (all SQL lives here)
providers/      # AssetProvider interface, registry, yahoo/, manual/, fx/
notifications/  # NotificationChannel interface, registry, inapp/, email/
jobs/           # BullMQ queues, processors, cron schedules
events/         # Domain event bus (Redis pub/sub), typed event definitions
```

**Dependency rule:** `http`/`realtime`/`jobs` → `services` → `domain` + `data` + `providers` + `notifications`. Never the reverse; `domain` imports nothing but types.

### 4.4 Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript end-to-end | One language, shared types via `contracts` |
| Frontend | React 19 + Vite + Tailwind 4 + react-router 7 | Static SPA build, fast dev loop |
| Client data | TanStack Query + generated API client | Caching, retries, focus-refetch = polite to the server |
| Charts | `lightweight-charts` (price/time series) + Recharts (donuts/bars) | TradingView-grade finance charts, tiny footprint |
| Backend | Node 22 + Express 5 | Boring, proven, huge ecosystem |
| Validation | zod (schemas in `contracts`) | Single definition for API + client |
| ORM / DB | Drizzle ORM + **PostgreSQL 17** | Typed SQL, real database for a real app |
| Cache / queues / sessions / pub-sub | **Redis 7** | Quote cache, BullMQ jobs, session store, event bus |
| Realtime | Socket.IO (Redis adapter) | Rooms, reconnects, fallbacks — SignalR-equivalent for Node |
| Jobs | BullMQ | Scheduled + retryable background work |
| Auth | Session cookies (httpOnly) + argon2id | Right fit for a closed user group (no JWT complexity) |
| Email | Nodemailer over SMTP (credentials via env) | Works with any mailbox you create later |
| Market data | `yahoo-finance2` (npm) | Free, no API key, covers XETRA (BAYN.DE), US, indices, FX — and gold/crypto symbols later for free. Unofficial → wrapped behind the provider interface, aggressively cached, swappable. |
| IDs | UUIDv7 | Sortable, index-friendly |
| Deploy | Docker Compose | One server, reproducible |
| CI | GitHub Actions | typecheck, lint, test, build on every push |

### 4.5 Realtime gateway

Socket.IO endpoint at `/ws`, authenticated via the same session cookie on handshake.

| Room | Joined by | Events pushed |
|---|---|---|
| `user:{id}` | The user's own clients (auto-join) | `notification.new`, `alert.triggered`, `portfolio.changed` |
| `asset:{id}` | Clients viewing that asset | `quote.update` (whenever the cached quote refreshes) |
| `conglomerate:{id}` | Owner + viewers of a shared link | `conglomerate.updated` (owner edited → viewers' pages refetch live) |

Internally, services publish **domain events** on a Redis pub/sub bus (`events/`); the gateway and the notification dispatcher are both subscribers. This keeps "something happened" decoupled from "who gets told how" — adding a new push target later (e.g. mobile push) is a new subscriber, not a code rewrite. Outbound user-defined webhooks: Future Feature.

### 4.6 Deployment topology (Docker Compose)

| Service | Image / role | Notes |
|---|---|---|
| `web` | nginx serving `apps/web/dist` | Static files w/ immutable cache headers; proxies `/api` → `api:3000` and `/ws` → `api:3000` (same-origin = no CORS, cookies just work) |
| `api` | Node (apps/api, entry `server.ts`) | HTTP + WebSocket |
| `worker` | Same image, entry `worker.ts` | BullMQ processors; scale independently if ever needed |
| `db` | postgres:17 | Volume `pgdata`; nightly `pg_dump` to volume `backups` |
| `redis` | redis:7 | AOF persistence on |

TLS terminates at your reverse proxy of choice in front (Caddy/Traefik/Cloudflare Tunnel) — out of scope here beyond: cookies are `Secure` in production. All configuration via environment variables (Section 11). Health endpoints: `GET /api/v1/health` (api), BullMQ ping (worker).

---

## 5. Data Layer

### 5.1 The provider abstraction (the "trackable" core)

Everything price-like flows through one interface:

```ts
type AssetRef = { providerId: string; providerRef: string }; // e.g. { 'yahoo', 'BAYN.DE' }

interface AssetProvider {
  readonly id: string; // 'yahoo' | 'manual' | future: 'metals', 'coingecko', ...

  search(query: string): Promise<AssetSearchResult[]>;
  getQuote(ref: AssetRef): Promise<Quote>;          // price, currency, prevClose, dayChangePct, asOf
  getHistory(ref: AssetRef, range: Range, interval: Interval): Promise<PricePoint[]>;
  getMeta(ref: AssetRef): Promise<AssetMeta>;        // name, symbol, exchange, currency, type
}
```

- A central **registry** maps `providerId → instance`. Services call `registry.for(asset).getQuote(...)` — nobody else knows which provider is behind an asset.
- **`manual` provider** backs custom investments: `getQuote` returns the latest value point, `getHistory` returns the value points with carry-forward. Consequence: portfolio charts, totals and P/L need **zero special-casing** for a house vs. a stock.
- **FX pairs are just assets** (`yahoo:EURUSD=X` etc.), so historical FX reuses the same caching/backfill machinery as stocks.
- Failure handling: provider calls are wrapped with timeouts (5 s), retry-once, and a circuit breaker; on failure the API serves the last cached value marked `stale: true` rather than erroring (stale-while-revalidate).
- Adding gold later = registering symbols (`XAUEUR=X`, `GC=F`) or a new provider file. Nothing else changes.

### 5.2 Market data: Yahoo Finance via `yahoo-finance2`

Capabilities used: `search()` (symbol/name lookup incl. European exchanges), `quote()` (live-ish price, currency, prev close, market state), `chart()` (OHLC history, **dividend/split-adjusted closes** — backtests are therefore total-return, same approach as the proven `stockportfolio/conglomerate.py` prototype).

Known risk: the API is unofficial and can change or rate-limit. Mitigations: (a) every byte is cached (below), (b) outbound calls run through a queue with concurrency 4 + exponential backoff on 429/5xx, (c) the provider interface makes replacement a contained change, (d) disclaimers in the UI (Section 10).

### 5.3 Caching strategy

| Data | Where | TTL | Notes |
|---|---|---|---|
| Quote | Redis | 60 s | One fetch serves all users viewing that asset |
| History 1D (1 m candles) | Redis | 60 s | |
| History 1W (15 m) | Redis | 5 min | |
| History 1M (30 m) | Redis | 15 min | |
| History 6M/1Y (1 d) | Redis | 1 h | |
| History 5Y (1 wk) / Max (1 mo) | Redis | 6 h | |
| **Daily closes** (for backtests/portfolio history) | **Postgres `price_history`** | permanent | Durable, bulk-queryable; nightly refresh job + on-demand backfill when an asset is first used (Section 9) |
| FX daily rates | Postgres (FX assets in `price_history`) | permanent | |

Cache keys are `{providerId}:{providerRef}:{kind}:{range}`. Request coalescing: concurrent misses for the same key trigger exactly one upstream fetch.

### 5.4 Currency handling

- Every asset keeps its **native currency** (`NVDA` USD, `BAYN.DE` EUR). All stored amounts are native.
- **Conversion happens at read/computation time** in one place: `services/currencyService` (current rates for quotes/totals, historical daily rates for backtests and portfolio history).
- Base currency is **EUR**, but it is a parameter throughout (`toBase(amount, currency, date?)`), never a literal — so per-user base currency (Future Feature) is a settings field + passthrough, not a refactor.
- Display: money 2 dp, quantities up to 6 dp, weights 1 dp (stored at higher precision, Section 5.5).

### 5.5 Database schema (PostgreSQL, via Drizzle)

Conventions: `id uuid pk` (UUIDv7), `created_at/updated_at timestamptz` everywhere (stored UTC, displayed Europe/Vienna); `numeric(20,8)` for quantities, `numeric(20,6)` for prices/values, `numeric(6,3)` for weights.

```
users               id, email UNIQUE NOT NULL, username UNIQUE NOT NULL,
                    password_hash, role ENUM(user, admin), status ENUM(active, disabled),
                    must_change_password bool, base_currency char(3) DEFAULT 'EUR',
                    last_login_at, created_at, updated_at

invites             id, email NOT NULL, token_hash UNIQUE, created_by → users,
                    expires_at (default +7 days), used_at NULL, revoked_at NULL

assets              id, provider_id, provider_ref, owner_id NULL → users,
                    type ENUM(stock, etf, index, fx, commodity, crypto, custom),
                    symbol, name, exchange NULL, currency char(3), meta jsonb,
                    UNIQUE(provider_id, provider_ref, owner_id)
                    -- owner_id NULL = global market asset; set = that user's custom asset

price_history       asset_id → assets, date, close numeric, UNIQUE(asset_id, date)
                    -- daily adjusted closes; also holds FX pairs and custom value points
                    -- (for custom assets this table IS the value-point store)

workboard_items     id, user_id, asset_id, sort_order int, note NULL,
                    UNIQUE(user_id, asset_id)

alerts              id, user_id, asset_id,
                    kind ENUM(price_above, price_below, pct_up_from_ref,
                              pct_down_from_ref, pct_day_up, pct_day_down),
                    threshold numeric, ref_price numeric NULL,  -- captured at creation for *_from_ref
                    repeat bool DEFAULT false, status ENUM(active, triggered, disabled),
                    last_triggered_at NULL

notifications       id, user_id, type, title, body, payload jsonb, read_at NULL, created_at

notification_settings  user_id, channel ENUM(inapp, email, telegram, discord),
                       enabled bool, config jsonb, UNIQUE(user_id, channel)

conglomerates       id, owner_id → users, name, description NULL,
                    status ENUM(draft, active), created_at, updated_at

conglomerate_positions  id, conglomerate_id, asset_id, weight_pct numeric(6,3),
                        sort_order int, UNIQUE(conglomerate_id, asset_id)

share_links         id, conglomerate_id, token UNIQUE (≥128-bit random, url-safe),
                    created_at, revoked_at NULL

portfolios          id, user_id, name DEFAULT 'Main', UNIQUE(user_id, name)
                    -- exactly one per user in v1 (auto-created); table exists so
                    -- multi-portfolio (Future Feature) is additive

transactions        id, portfolio_id, asset_id, side ENUM(buy, sell),
                    quantity numeric(20,8) > 0, price numeric(20,6) >= 0,  -- native currency
                    fee numeric(20,6) DEFAULT 0, executed_at timestamptz, note NULL

audit_log           id, actor_id NULL → users, action, target_type, target_id,
                    ip, meta jsonb, created_at
                    -- login.success/fail, user.created/disabled/deleted/pw_reset,
                    -- invite.created/used/revoked, admin.login
```

Sessions live in **Redis** (not Postgres). Deleting a user cascades to everything they own; share links die with their conglomerate.

---

## 6. Business Layer — Feature Specifications

Each spec defines behavior precisely enough to implement and test against.

### 6.1 Authentication & accounts

- **Login** (`POST /auth/login`, email-or-username + password): argon2id verify; on success rotate session ID, set `last_login_at`, audit-log. Generic error message on failure (no user enumeration). Rate limit: 5/min per IP and 10/h per account; lockout 15 min after 10 consecutive failures.
- **Sessions:** httpOnly, `SameSite=Lax`, `Secure` (prod) cookie → Redis session (30-day rolling expiry). Password change or account disable kills **all** sessions of that user instantly.
- **Forced password change:** users created with a temp password have `must_change_password=true`; every API call except `change-password`/`logout` returns `403 PASSWORD_CHANGE_REQUIRED`; the SPA traps this into the change screen.
- **Invite accept** (`GET /invite/:token` page → `POST /auth/accept-invite`): token valid = unused, unrevoked, unexpired (7 days). Email is fixed from the invite; user picks username + password; account becomes `active`; invite marked used; user is logged in.
- **Password policy:** ≥ 10 chars, no composition rules, top-10k-common-passwords blocklist. Temp passwords: 16-char random, shown to the admin exactly once.

### 6.2 Search

- `GET /search?q=` → provider search (debounced 300 ms client-side, min 2 chars, rate limit 60/min/user) **merged with** the user's own custom assets matching by name.
- Results: symbol, name, exchange, type badge, currency. Actions on every result: **→ Workboard**, **→ Conglomerate** (picker of own conglomerates / "new"), **→ Portfolio** (opens buy-transaction dialog).
- First time any user touches a market asset, it is upserted into `assets` (global row) and a history backfill job is enqueued.
- UI: dedicated `/search` page + global **Cmd/Ctrl-K palette** from anywhere.

### 6.3 Asset detail page

- Chart (lightweight-charts, area style) with ranges **1D · 1W · 1M · 6M · 1Y · 5Y · Max** (range→interval mapping = the cache table in 5.3). Custom assets: value points, step-line.
- Header: name, symbol, exchange, native price + day change (green/red), EUR-converted price if foreign, `asOf` timestamp + `stale` marker when the provider is down, "data may be delayed" footnote.
- Stats row (when the provider supplies it): prev close, day range, 52-week range, market state.
- Sections: *Your alerts on this asset* (inline create/edit), *Appears in* (your conglomerates / portfolio holdings), action buttons (Workboard ±, add to Conglomerate, record Buy).
- While the page is open the client joins `asset:{id}` and live-updates the quote on `quote.update` (~60 s cadence in v1; second-level LIVE view is a Future Feature).

### 6.4 Workboard

The user's home for *observing*. Three zones:

1. **Watchlist** — table of watched assets: sparkline (1M), price, day ±%, alert count badge; drag-to-reorder (`sort_order`), per-row note, remove. Empty state points to search.
2. **Alerts panel** — all alerts across assets: asset, rule in plain words ("notify when BAYN.DE drops 20% from 28.50 €"), status (active / triggered / disabled), toggle, delete.
   - **Rule semantics:** `price_above/below`: current ≥ / ≤ threshold. `pct_up/down_from_ref`: change vs. `ref_price` (captured at alert creation) ≥ threshold %. `pct_day_up/down`: day change vs. prev close ≥ threshold %.
   - **Lifecycle:** evaluated every minute (Section 9) against cached quotes. One-shot (default): fire once → status `triggered` (re-arm manually). `repeat=true`: after firing, 24 h cooldown, then re-arms automatically.
   - Firing = domain event → notification fan-out (6.11) + row update pushed via socket.
3. **My Conglomerates** — card grid: name, positions count, 1Y mini-chart, total return badge; click → detail; "New Conglomerate" card.

### 6.5 Conglomerates & the Builder

**Model rules:** 1–50 positions; weights `0 < w ≤ 100` with ≤ 3 decimals; **status `active` requires Σ weights = 100 ± 0.01**; `draft` allows any state. Names unique per owner (case-insensitive). Deleting a conglomerate (confirm dialog) hard-deletes it and revokes its share links.

**The Builder** (`/conglomerates/new`, `/conglomerates/:id/edit`) is its own full-screen experience — the flagship UX of the app:

- **Left panel — Add assets:** embedded search; click adds a position at weight 0.
- **Center — Positions:** one row per position: symbol/name, weight number-input (0.001 precision) + slider (0–100, step 0.5), **lock toggle** 🔒, remove. Footer: live **sum pill** — green "100.0%" when valid, amber "87.5% — 12.5% left" otherwise, with the active/draft implication spelled out.
  - **Auto-balance:** distributes `100 − Σ(locked)` equally across unlocked positions.
  - **Normalize:** scales unlocked positions proportionally so the total hits exactly 100 (locked untouched; error if locked alone ≥ 100).
- **Right panel — Live preview:** allocation donut + backtest chart (range toggle 1Y/3Y/5Y/Max) + headline stats, recomputed **debounced 500 ms** after any weight change. This is why backtests must be fast (warm `price_history`, Section 6.6) — the Builder should feel like an instrument, not a form.
- **Autosave:** every change persists to the `draft` immediately (status pill "Draft — saved"). "Activate" runs validation and flips to `active`. Editing an active conglomerate updates it in place (shared-link viewers see changes live — by design, per product decision).

### 6.6 Backtest engine

Pure function in `domain/backtest.ts`:

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

- Benchmarks: overlay toggle for `^GSPC` (S&P 500), `^GDAXI` (DAX), `URTH` (MSCI World ETF) — same pipeline, weight 100.
- API: `GET /conglomerates/:id/backtest?range=5y&benchmark=^GSPC`; preview for unsaved Builder state: `POST /backtest/preview` with positions in the body.
- Results memoized in Redis 1 h keyed by hash(positions+range) — Builder slider-wiggling stays cheap.

### 6.7 Invest Calculator (budget → buy list)

Pure function in `domain/allocation.ts`. Inputs: active conglomerate, budget `B` in EUR, mode `whole | fractional` (+ optional fractional step, e.g. 0.0001 for brokers with 4-dp fractions). Prices: current quotes EUR-converted. **Hard guarantee: total cost ≤ B. Never overshoot.**

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
  Step 2: BAYN 12×25 = 300 €, NVDA 4×150 = 600 €, GOOGL 0×140 = 0 €. Leftover 100 € < 140 € ⇒ no fill possible. **Result: 900 € spent, 100 € left, GOOGL 0% vs target 10% — flagged: "GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1400 € or use fractional mode."** The calculator must surface unreachable weights exactly like this rather than silently mis-weighting. (With friendlier prices the leftover lands near zero — e.g. the 996.32 € of 1000 € case — but the ≤-budget guarantee is what's promised, not a specific fill rate.)
- Edge cases: any single price > B ⇒ position flagged unbuyable; market closed ⇒ uses last close with notice; stale quotes ⇒ warning banner.
- **Buy flow ("the quick way"):** result table → **Add to Portfolio** → dialog pre-filled with one BUY transaction per non-zero position (qty & price from the calculation, `executed_at = now`, all editable) → confirm ⇒ bulk-insert transactions. One screen, two clicks from plan to recorded reality.

### 6.8 Sharing, export & import

- **Live share link:** owner clicks Share → `POST /conglomerates/:id/share` → token URL `https://…/s/{token}`. Viewer must be logged in (closed app). Viewer sees the **current** state read-only — name, positions, donut, backtest, calculator (usable with their own budget) — and a **Clone to my account** button (copies name + positions as their own draft, note "cloned from {owner}'s {name}"). Owner edits propagate immediately (`conglomerate.updated` socket ping → viewer page refetches). Owner can list and **revoke** links; revoked token → 404.
- **Export JSON** (`GET /conglomerates/:id/export`):
  ```json
  {
    "bettertrack_export": 2,
    "kind": "conglomerate",
    "name": "BioTech+Defense",
    "description": null,
    "exported_at": "2026-06-13T10:00:00Z",
    "positions": [
      { "provider": "yahoo", "ref": "BAYN.DE", "symbol": "BAYN.DE",
        "name": "Bayer AG", "weight": 30.0 }
    ]
  }
  ```
- **Import** (`POST /conglomerates/import`): validates with the shared zod schema; resolves each position (known `provider+ref`, else provider search by symbol); unresolved positions are listed for manual fixing in the Builder (import lands as `draft`). Name collision ⇒ " (imported)" suffix. **Also accepts the legacy prototype format** from `stockportfolio/conglomerate.py` (`{version:1, conglomerates:{…holdings:[{ticker,name,weight}]}}`, tickers resolved via Yahoo) — existing baskets carry over on day one.

### 6.9 Portfolio

- **Transactions are the source of truth**; holdings are derived, never stored.
  - BUY: quantity, price (native currency), fee, timestamp, note. SELL: same; rejected if it would push held quantity negative ("you only hold 3.5 shares").
  - **Average-cost basis:** buys re-average `avg_cost = (held_qty·avg_cost + qty·price + fee) / (held_qty + qty)`; sells reduce quantity, avg cost unchanged; realized P/L of a sell = `qty·(price − avg_cost) − fee` (shown on the transaction row; full realized-P/L reporting & FIFO/tax lots are Future Features).
- **Holdings view:** per asset — quantity, avg cost, current price, market value (EUR), unrealized P/L € and %, day change; expandable to its transactions. Totals header: market value, invested (open cost basis), unrealized P/L €/%, day change €/%.
- **Value-over-time chart:** daily series from first transaction to today: `Σ over assets of qty_held(d) · price_EUR(d)` using `price_history` + historical FX; custom assets contribute their carried-forward value points. Computed on demand, cached 1 h, invalidated on any transaction/value-point change. Ranges 1M/6M/1Y/Max.
- **Allocation donuts:** by asset and by type (stock/ETF/custom/…).
- **Custom investments:** create (name; category: real estate · vehicle · collectible · cash · unlisted stock · other; currency; optional initial purchase as a BUY transaction at a chosen date/price). **Value points** editor: list of (date, value) rows, add/edit/delete, one per day. Between points the value carries forward (step function — honest about sparse data). A custom asset then behaves like any asset: chartable, holdable, watchable, even usable in conglomerates (allowed, documented).
- The Portfolio page answers, at a glance: *what do I own, what is it worth right now, what did it cost me, how is it doing today and over time* — for stocks and the house alike.

### 6.10 Dashboard (main page `/`)

Calm overview, one `GET /dashboard` call:

- Greeting + date; if a portfolio exists: **portfolio card** (total value, day Δ € / %, 30-day sparkline).
- **Top movers today** — best 3 / worst 3 across the user's holdings + watchlist.
- **Market strip** — DAX, S&P 500, NASDAQ, EUR/USD (global cache, zero per-user cost).
- **Latest notifications** (5, with unread state) · **Quick actions** (search, new conglomerate, add transaction).
- Tasteful empty states for new accounts ("Search your first stock →").

### 6.11 Notifications & channels

```ts
interface NotificationChannel {
  readonly id: 'inapp' | 'email' | 'telegram' | 'discord' | string;
  send(user: User, n: NotificationMessage): Promise<void>;
}
```

- **Registry + per-user settings** (`notification_settings`): in-app always on; email on by default (it's the primary channel per product decision); future channels = implement the interface, register it, add a settings toggle + config fields (e.g. chat id). **Adding a channel never touches alert logic** — the dispatcher fans out one `NotificationMessage` to all enabled channels, at-least-once, deduped per (user, event key).
- **In-app:** bell with unread badge (live via socket), dropdown list, mark-read/mark-all; full list in settings.
- **Email:** Nodemailer + SMTP from env (any mailbox you set up later). Minimal clean HTML templates: alert triggered (asset, rule, price, link), invite, temp password, welcome. Failures logged + retried (3×, exponential).
- Notification types v1: `alert.triggered`, `account.invite`, `account.temp_password`, `system.announcement` (admin-sent, Future Feature toggle).

### 6.12 Admin area

- **Separate world:** `/admin/login` + `/admin/*` — own minimal layout (no app navigation), same auth backend with `role=admin` required; non-admins get a 404 (no information leak). Backend routes live under `/api/v1/admin/*` behind role middleware. Audit-logged throughout.
- **Users:** table (email, username, status, role, last login, created) with search/filter. Actions:
  - **Create user** — email + username + generated 16-char temp password (shown once) → user must change it on first login.
  - **Invite** — email → tokenized link (7-day expiry) to copy or auto-send via the email channel; list pending invites, resend, revoke.
  - **Disable / enable** (disable kills sessions instantly), **reset password** (new temp, shown once), **delete** (type-username-to-confirm; cascades all data).
- **Overview cards:** user count, active (logged in ≤ 30 d), pending invites, tracked assets, job queue health (last run / failures).
- **Audit log:** filterable table of `audit_log`.
- Explicitly **not** in v1: admin browsing user portfolios (privacy), feature flags, announcements (Future Features).

---

## 7. Display Layer — Web App

### 7.1 Principles

- Pure static SPA (Vite build → `dist/`), served by nginx with immutable cache headers; `index.html` no-cache for instant deploys. All rendering, routing and state in the browser — **your server only ever answers JSON**.
- TanStack Query for all server state: per-endpoint `staleTime` mirroring server cache TTLs (quotes 60 s, history per range), refetch-on-focus, request dedup — a polite client by construction.
- Socket integration is **enhancement only**: connected ⇒ instant updates; disconnected ⇒ everything still works via query refetch.
- Dark theme default (finance app at night), light toggle later. Desktop-first, fully usable on mobile (responsive tables → cards). Skeleton loaders, error boundaries with retry, designed empty states on every list. Locale: `de-AT` number/date formatting (1.234,56 €).
- Auth: cookie-based; any 401 → login redirect; `403 PASSWORD_CHANGE_REQUIRED` → forced-change screen.

### 7.2 Routes

| Route | Page | Guard |
|---|---|---|
| `/login` | Login | public |
| `/invite/:token` | Accept invite | public |
| `/` | Dashboard | user |
| `/search` | Search & results (+ global ⌘K palette) | user |
| `/assets/:id` | Asset detail | user |
| `/workboard` | Watchlist · Alerts · My conglomerates | user |
| `/conglomerates` | List + import | user |
| `/conglomerates/new`, `/conglomerates/:id/edit` | **Builder** | user (owner) |
| `/conglomerates/:id` | Detail: backtest · positions · **calculator** · sharing | user (owner) |
| `/s/:token` | Shared conglomerate (read-only + clone) | any logged-in user |
| `/portfolio` | Holdings · transactions · custom investments | user |
| `/settings` | Password · notification channels | user |
| `/admin/login`, `/admin/*` | Admin area (own layout) | admin |

### 7.3 Component inventory (the reusable core)

`AssetSearchBox` (used by Search page, ⌘K, Builder, buy dialogs) · `PriceChart` (lightweight-charts wrapper: ranges, area/step modes, benchmark overlay) · `Sparkline` · `AllocationDonut` · `WeightRow` (input+slider+lock) · `SumPill` · `BudgetCalculator` (budget input, mode toggle, result table, Add-to-Portfolio) · `TransactionDialog` (single & bulk prefilled) · `ValuePointEditor` · `NotificationBell` · `MoneyText` (native + EUR, sign-colored) · `StatCard` · `EmptyState`.

### 7.4 API client

Generated from `packages/contracts` (zod → typed fetch wrapper): every call fully typed end-to-end, errors normalized to the API envelope, one place for auth/redirect/toast policy. The same package is what a future mobile app imports.

---

## 8. API Reference (v1 surface)

Conventions: base `/api/v1`, JSON, camelCase; errors `{ error: { code, message, details? } }`; cursor pagination `?limit&cursor` where lists can grow; all routes require a session unless marked **P** (public). Versioning: additive changes only within v1; breaking ⇒ `/api/v2`.

| Area | Endpoints |
|---|---|
| Auth | **P** `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/change-password` · **P** `GET /auth/invite/:token` (validate) · **P** `POST /auth/accept-invite` |
| Search | `GET /search?q=` |
| Assets | `GET /assets/:id` · `GET /assets/:id/quote` · `GET /assets/:id/history?range=` |
| Workboard | `GET /workboard` · `POST /workboard` `{assetId}` · `DELETE /workboard/:itemId` · `PATCH /workboard/reorder` |
| Alerts | `GET /alerts` · `POST /alerts` · `PATCH /alerts/:id` (toggle/edit) · `DELETE /alerts/:id` |
| Notifications | `GET /notifications?cursor=` · `POST /notifications/mark-read` `{ids|all}` |
| Conglomerates | `GET /conglomerates` · `POST /conglomerates` · `GET/PATCH/DELETE /conglomerates/:id` · `PUT /conglomerates/:id/positions` (bulk replace — autosave) · `POST /conglomerates/:id/activate` · `GET /conglomerates/:id/backtest?range&benchmark` · `POST /backtest/preview` · `POST /conglomerates/:id/allocate` `{budgetEur, mode, step?}` · `POST /conglomerates/:id/share` · `GET /conglomerates/:id/shares` · `DELETE /shares/:id` · `GET /conglomerates/:id/export` · `POST /conglomerates/import` |
| Shared | `GET /s/:token` · `POST /s/:token/clone` |
| Portfolio | `GET /portfolio` (holdings+totals) · `GET /portfolio/history?range=` · `GET /portfolio/transactions?cursor=` · `POST /portfolio/transactions` (single or bulk — the buy flow) · `PATCH/DELETE /portfolio/transactions/:id` · `POST /custom-assets` · `PATCH/DELETE /custom-assets/:id` · `GET/PUT /custom-assets/:id/value-points` |
| Dashboard | `GET /dashboard` |
| Settings | `GET/PATCH /settings/notifications` |
| Admin | `GET /admin/users` · `POST /admin/users` · `PATCH /admin/users/:id` (disable/enable/role) · `POST /admin/users/:id/reset-password` · `DELETE /admin/users/:id` · `GET/POST /admin/invites` · `POST /admin/invites/:id/revoke` · `GET /admin/stats` · `GET /admin/audit?cursor=` |
| Meta | **P** `GET /health` |

WebSocket: `/ws` (Socket.IO; session-cookie handshake; rooms & events per 4.5).

---

## 9. Background Jobs & Domain Events

| Job (BullMQ) | Schedule | What it does |
|---|---|---|
| `alerts.evaluate` | every 1 min | Distinct assets with active alerts → quotes (cached) → `domain/alertEval` → fire events for matches; honors one-shot/repeat lifecycle (6.4). Idempotency key per (alert, trigger window) prevents double-fires across retries. |
| `prices.refreshDaily` | nightly 03:00 Europe/Vienna | Upsert yesterday's daily closes into `price_history` for every asset referenced by any workboard/conglomerate/portfolio + all FX pairs in use. |
| `prices.backfill` | on demand | First time an asset is used: fetch max-range daily history into `price_history` (queued, ~1 asset/sec — polite). |
| `fx.refreshSpot` | hourly | Refresh current FX rates used by `currencyService`. |
| `notifications.dispatch` | on event | Fan out a fired event to the user's enabled channels; per-channel retry 3× exponential. |

Retries: 3 attempts, exponential backoff, dead-letter list visible in admin stats. All schedules live in code (no external cron).

**Domain events** (Redis pub/sub, typed in `events/`): `alert.triggered` · `notification.created` · `quote.updated` · `conglomerate.updated` · `portfolio.changed`. Producers: services/jobs. Consumers: realtime gateway (→ socket rooms), notification dispatcher. New consumers (mobile push, user webhooks) subscribe without touching producers.

---

## 10. Security & Privacy

- **Closed by default:** every route/socket requires a session except login/invite/health; admin routes additionally require `role=admin`; object access is always scoped `WHERE owner_id = session.user` (no IDOR by construction — enforced in repositories, not controllers).
- **Passwords:** argon2id (memory 64 MB, iterations 3, parallelism 1); session rotation on login; all-session invalidation on password change/disable.
- **Cookies/CSRF:** httpOnly + `SameSite=Lax` + `Secure`; state-changing requests additionally require an `X-Requested-With: BetterTrack` header (cheap CSRF belt-and-suspenders since there are no cross-site embeds); strict `Origin` check on the socket handshake.
- **Headers:** helmet with a strict CSP (self-only scripts; no third-party assets — fonts/icons bundled).
- **Validation:** every request body/query parsed by the shared zod schema before any logic; unknown fields rejected.
- **Rate limits** (Redis): login 5/min/IP · search 60/min/user · general API 600/15 min/user · admin endpoints 120/15 min.
- **Share tokens:** ≥ 128-bit CSPRNG, url-safe, constant-time compare, revocable; tokens never logged.
- **Outbound safety:** provider HTTP fixed to known hosts (no user-supplied URLs in v1 ⇒ no SSRF surface); secrets only via env; `.env` git-ignored, `.env.example` documented; `pnpm audit` in CI.
- **Privacy:** PII = email only; user deletion cascades all data; no analytics/trackers; logs (pino, JSON) exclude bodies and tokens. Backups: nightly `pg_dump`, 14-day rotation, restore procedure documented in README.
- **Disclaimers (footer + asset pages):** market data comes from an unofficial source and may be delayed or inaccurate; BetterTrack is not investment advice.

---

## 11. Configuration & Environments

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://bt:…@db:5432/bettertrack` | |
| `REDIS_URL` | `redis://redis:6379` | |
| `SESSION_SECRET` | 64 random bytes | rotatable (keyed array) |
| `APP_ORIGIN` | `https://track.example.at` | cookie/origin checks, link generation |
| `SMTP_HOST/PORT/USER/PASS/FROM` | — | empty ⇒ email channel disabled, app still runs |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | seeds the first admin on first boot only |
| `PORT` | `3000` | api |

- **Dev:** `docker compose -f infra/docker-compose.dev.yml up` (db+redis) → `pnpm dev` (vite + tsx watch + worker). Drizzle migrations: `pnpm db:migrate`; seed script creates admin + demo user.
- **Prod:** `docker compose up -d` in `infra/` — five services from 4.6; deploy = build images, run migrations, restart api/worker/web.

---

## 12. Testing & Quality

- **Domain layer = the testing crown jewels.** Table-driven Vitest suites for `allocation` (incl. the worked example in 6.7, unreachable weights, budget edges, fractional steps), `backtest` (clipping, FX conversion, carry-forward, drawdown math), `holdings` (avg-cost across buy/sell sequences, oversell rejection), `alertEval` (all six kinds, repeat/cooldown). These run in milliseconds and gate every commit.
- **Service/API tests:** Supertest against a test Postgres (testcontainers), providers mocked with recorded fixtures — auth flows, ownership scoping, invite lifecycle, import edge cases.
- **Contracts:** zod schemas type-checked against handlers at compile time.
- **E2E (thin):** one Playwright happy path — login → search → watch → build conglomerate → allocate → add to portfolio. Run nightly, not per-commit.
- **CI (GitHub Actions):** install → typecheck → lint → unit/service tests → build web + api images. Tags push images.

---

## 13. Milestones

Each phase ends in something usable; "done" = acceptance criteria met + tests for that phase green.

| Phase | Scope | Done when |
|---|---|---|
| **P0 — Foundation** | Monorepo, contracts package, compose (db/redis), Drizzle schema + migrations, auth (login/sessions/forced-change), seeds, admin area: user CRUD + invites + audit, email plumbing (invite/temp-pw mails), CI | Admin creates + invites a user; invited user sets a password, logs in; a disabled user is locked out instantly |
| **P1 — Market data & watching** | Provider abstraction + yahoo + caching + backfill jobs, search (+⌘K), asset page w/ ranges, workboard watchlist, FX/currency service | Search "bayer" → add BAYN.DE → chart all ranges; EUR conversion correct; provider outage degrades to stale-cache, not errors |
| **P2 — Portfolio** | Transactions CRUD + holdings math, portfolio page (totals, holdings, history chart, donuts), custom investments + value points via `manual` provider | The exact flow: record real buys, add a house with two value points, see combined value-over-time in EUR |
| **P3 — Conglomerates** | Model + CRUD, **Builder** (locks, auto-balance, normalize, autosave, live preview), backtest engine + benchmarks, detail page | Build 30/60/10 BAYN/NVDA/GOOGL, activate, 5Y backtest vs S&P 500 with correct clipping notice |
| **P4 — Calculator & sharing** | Allocation algorithm (both modes) + UI, buy-flow into portfolio, share links (live, revocable, clone), JSON export/import incl. legacy format | 1000 € → buy list ≤ budget with deviation table; a link viewed by a second account updates live; prototype JSON imports clean |
| **P5 — Alerts & notifications** | Notification channel abstraction, in-app center + email channel, alert rules + evaluator job, realtime gateway (rooms/events), settings page | BAYN drop-20% alert fires once, lands in bell + inbox within a minute; a socket-dead client still sees it on refetch |
| **P6 — Dashboard & polish** | Dashboard, empty states, skeletons, responsive pass, disclaimers, backups, deploy guide, e2e | Fresh invite → first stock → first conglomerate without confusion on a phone browser; `docker compose up` on a clean server works from the README alone |

---

## 14. Future Features

The intentional parking lot — scoped out of v1, designed-for in v1. Roughly ordered by leverage; items marked ⚡ are nearly free because of the architecture.

**Market data & assets**
- ⚡ **Gold & commodities** — register Yahoo symbols (`XAUEUR=X`, `GC=F`) under type `commodity`; a new asset class for ~zero code.
- ⚡ Crypto via Yahoo (`BTC-EUR`) or a dedicated CoinGecko provider as the second real provider.
- **LIVE view** — on an asset page, a LIVE button streaming ~1-second ticks over windows of 1 m / 5 m / 10 m / 30 m / 1 h / 5 h: the worker polls hot symbols into a Redis ring buffer and streams via the existing `asset:{id}` rooms; auto-stops when nobody is watching. (Builds directly on 4.5 — the rooms already exist.)
- Provider failover chains (yahoo → backup source per asset class); bonds; earnings calendar; per-asset news feed.

**Currency & portfolio**
- **Per-user base currency** — settings field feeding the already-parameterized `currencyService` (explicit product decision: deferred, not rejected).
- Multiple portfolios per user (table already keyed for it); FIFO/tax-lot accounting + realized P/L & fee/dividend reports (AT tax view); CSV broker import (Flatex/Trade Republic/IBKR mappers); dividend tracking as cash-flow transactions; portfolio daily snapshot table for instant history at scale; benchmark-vs-portfolio overlay ("you vs. just buying URTH").

**Conglomerates**
- Rebalanced backtest mode (monthly/quarterly/yearly) alongside buy-and-hold; conglomerate-vs-conglomerate compare overlay; what-if editing on shared views (sandbox copy); nested conglomerates (basket of baskets); public gallery / follow / comments — the social layer, gated by the same closed-accounts model.

**Alerts & notifications**
- ⚡ **Telegram + Discord channels** — implement `NotificationChannel`, register, add settings fields; the dispatcher already fans out.
- Outbound **user-defined webhooks** (POST JSON on events — the integration escape hatch); richer rules (MA cross, RSI, trailing stop, volume spike, conglomerate-level moves); digest mode (daily/weekly summary email); quiet hours; web-push notifications (PWA).

**Clients**
- **PWA** first (installable, offline shell, web-push) — then a native/React-Native app speaking the identical API + socket (the entire point of API-first); read-only kiosk/TV dashboard mode.
- Share link that is either a freezeshot shown of the users portfolio (customizeable which assets get shared) or a live update.
- Add friends within the app to see their portfolio or other things they share

**Accounts & security**
- Self-service password reset by email; 2FA (TOTP) / passkeys; full account data export (GDPR-style); session manager UI ("log out that device").

**Admin & ops**
- Usage analytics, feature flags, announcement banners (`system.announcement` type exists); bull-board job dashboard mounted in admin; Sentry; Prometheus/Grafana; staging compose profile.

**Speculative**
- AI insights ("your portfolio is 71% US tech — concentration note"), natural-language conglomerate builder ("defensive EU dividend basket, 12 positions"); i18n DE/EN; light theme.

---

## 15. Open Items (owner to provide — none block development)

1. Domain name + server for deployment (compose runs anywhere meanwhile).
2. SMTP account / app mailbox (the email channel stays gracefully disabled until set).
3. Logo & accent color (placeholder wordmark until then).

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
