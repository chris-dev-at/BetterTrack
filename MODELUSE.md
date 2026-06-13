# BetterTrack — Model Use Plan

Which Claude model + effort level to use for each part of the v1 build (phases and section numbers reference `PROJECTPLAN.md`). Ground rules, per the owner:

- **When in doubt, go one tier up** — slightly over-spec is the policy.
- **The floor is Sonnet 4.6 at `high` effort.** Nothing runs below that — no Haiku, no medium/low.
- Set per session in Claude Code with `/model` and `/effort`. One work package per session keeps the prompt cache warm and the model consistent.

## The ladder

| Tier | Model (`/model`) | Effort (`/effort`) | Use for |
|---|---|---|---|
| **T1 — Fable** | Claude Fable 5 (`claude-fable-5`) | `max` for first implementation of the money-math cores; `xhigh` otherwise | Correctness-critical algorithms, architectural keystones, final reviews |
| **T2 — Opus** | Claude Opus 4.8 (`claude-opus-4-8`) | `xhigh` | Security boundaries, concurrency/caching, complex interactive UI, anything subtle |
| **T3 — Sonnet (floor)** | Claude Sonnet 4.6 (`claude-sonnet-4-6`) | `high` | CRUD pages, config files, boilerplate, docs, straightforward UI |

> If your Claude Code build only offers `high`/`max` in `/effort`, read `xhigh` as `max`.

## Per-phase assignments

### P0 — Foundation
| Work | Tier |
|---|---|
| Auth: sessions, argon2, rate limits/lockout, forced password change, invite flow (§6.1) · Admin area + role middleware (§6.12) · Drizzle schema + migrations (§5.5) | **T2 Opus xhigh** (default for this whole phase — mistakes here propagate) |
| Monorepo/pnpm setup, tsconfig/eslint, CI yaml, docker-compose, nginx conf, seed scripts | T3 Sonnet high |

### P1 — Market data & watching
| Work | Tier |
|---|---|
| Provider abstraction + registry, caching/request-coalescing/circuit breaker, currency service (§5.1, §5.3, §5.4) | **T1 Fable xhigh** — the architectural keystone everything else sits on |
| Yahoo provider implementation, backfill/refresh jobs (§9) | T2 Opus xhigh |
| Search page + ⌘K palette, asset detail page, workboard watchlist UI (§6.2–6.4) | T3 Sonnet high |

### P2 — Portfolio
| Work | Tier |
|---|---|
| `domain/holdings` (avg-cost math, P/L), portfolio value-over-time reconstruction, their table-driven tests (§6.9) | **T1 Fable max** |
| Transactions/custom-assets services + API, validation rules | T2 Opus xhigh |
| Portfolio page UI, dialogs, value-point editor | T3 Sonnet high |

### P3 — Conglomerates
| Work | Tier |
|---|---|
| `domain/backtest` (clipping, historical FX, drawdown/CAGR/contribution) + tests (§6.6) | **T1 Fable max** |
| **The Builder** — sliders/locks/auto-balance/normalize, autosave, debounced live preview (§6.5); it's the flagship UX and gnarly frontend state | T2 Opus xhigh |
| Conglomerate CRUD, list/detail scaffolding | T3 Sonnet high |

### P4 — Calculator & sharing
| Work | Tier |
|---|---|
| `domain/allocation` — the never-overshoot budget algorithm, edge cases, tests (§6.7) | **T1 Fable max** |
| Share links/tokens, clone, live-update wiring, JSON import/export incl. legacy format (§6.8) | T2 Opus xhigh |
| Calculator UI, buy-flow dialogs | T3 Sonnet high |

### P5 — Alerts, notifications, realtime
| Work | Tier |
|---|---|
| Alert evaluation semantics (six kinds, repeat/cooldown, idempotent firing) (§6.4, §9) | **T1 Fable xhigh** |
| Socket.IO gateway + rooms + event bus, NotificationChannel abstraction + dispatcher (§4.5, §6.11) | T2 Opus xhigh |
| Email templates, settings page, notification bell/center UI | T3 Sonnet high |

### P6 — Dashboard & polish
| Work | Tier |
|---|---|
| Final visual/responsive design pass across the app | T2 Opus xhigh (strong design instincts; give it your palette or it defaults to its own) |
| Dashboard page, empty states, skeletons, Playwright e2e, deploy guide/docs | T3 Sonnet high |
| **Pre-release review:** `/code-review high` over the whole branch before tagging v1 | **T1 Fable xhigh** |

## Cross-cutting rules

1. **`domain/` is Fable territory, always.** Any file under `apps/api/src/domain/` (allocation, backtest, holdings, alertEval) — first implementation at `max`, later edits at `xhigh`, never below T1. This is where a silent off-by-one costs real money.
2. **Security floor is Opus.** Anything touching auth, sessions, admin routes, share tokens, or rate limiting never drops to T3 — not even "trivial" edits.
3. **Escalate instead of looping.** If the same bug survives two fix attempts, move up one tier (and effort) immediately. Three Sonnet retry loops cost more than one Fable turn — and waste your weekly cap on failure.
4. **Plan deviations go through T1.** If implementation reveals the PROJECTPLAN needs changing, discuss it with Fable at `xhigh` and update the Decision Log (§16) before coding around it.
5. **Reviews:** quick `/code-review` per PR on whatever model the session runs; the money-math PRs (P2–P4 domain code) additionally get a Fable review before merge.
6. **Unsure which tier? Take the higher one.** That's the policy, codified.
7. Subagents Claude Code spawns on its own (Explore etc.) pick their own cheaper models — leave them be.

## Expected cost vs. all-Fable

All-Fable-max for everything was estimated at ~$900–1,700 API-equivalent. This split lands around **$500–900** (over-speced on purpose), with most of the spend concentrated in the P2–P4 domain cores where it belongs — roughly one month of Max 5x, or a couple of heavy weeks on Max 20x.
