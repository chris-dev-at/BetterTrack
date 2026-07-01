# BetterTrack — Model Use Plan

Which Claude model + effort level to use for each part of the V1 build (phases and section numbers reference `PROJECTPLAN.md`, plan v2). Ground rules, per the owner:

- **When in doubt, go one tier up** — slightly over-spec is the policy.
- **The floor is Sonnet 5 at `high` effort.** Nothing runs below that — no Haiku, no medium/low.
- Set per session in Claude Code with `/model` and `/effort`. One work package per session keeps the prompt cache warm and the model consistent.

## The ladder

| Tier | Model (`/model`) | Effort (`/effort`) | Use for |
|---|---|---|---|
| **T1 — Fable** | Claude Fable 5 (`claude-fable-5`) | `max` for first implementation of the money-math cores; `xhigh` otherwise | Correctness-critical algorithms, architectural keystones, final reviews |
| **T2 — Opus** | Claude Opus 4.8 (`claude-opus-4-8`) | `xhigh` | Security boundaries, concurrency/caching, complex interactive UI, anything subtle |
| **T3 — Sonnet (floor)** | Claude Sonnet 5 (`claude-sonnet-5`) | `high` | CRUD pages, config files, boilerplate, docs, straightforward UI |

> If your Claude Code build only offers `high`/`max` in `/effort`, read `xhigh` as `max`.

## Per-phase assignments

### P0 — v2 shell & restructure
| Work | Tier |
|---|---|
| File moves per §7.3 move table, ComingSoon placeholders, docs/ tidy, login-card restyle, README pointer updates | T3 Sonnet high |
| New AppLayout: 5-tab nav + subnavs + profile dropdown (final structure, gets lived in daily) | T2 Opus xhigh |

### P1 — Asset catalog, local search & cache rework
| Work | Tier |
|---|---|
| Local search index core: catalog schema/indexes (tsvector + pg_trgm), ranking, local-first query path, provider-fallback orchestration (§6.2) | **T1 Fable xhigh** |
| Caching/request-coalescing/serve-stale/negative-cache/provider-budget rework (§5.3) — the politeness keystone | **T1 Fable xhigh** |
| `catalog.enrich` job, seed list plumbing, migrations | T2 Opus xhigh |
| Search UI updates ("Searching providers…" affordance, Assets overview entry) | T3 Sonnet high |

### P2 — Identity, sessions & topology
| Work | Tier |
|---|---|
| Admin/user account-kind split, 30-day sessions + PIN, progressive rate limiting (§6.1, §10) | **T2 Opus xhigh** (security boundary — never below) |
| Topology env scheme + derived origins + CORS/cookie derivation (§11) | T2 Opus xhigh |
| nginx templates (both modes), compose wiring, SPA runtime config injection | T3 Sonnet high |

### P3 — Portfolio v2 & multi-portfolio prep
| Work | Tier |
|---|---|
| `portfolio_id`-scoping migration of schema/repositories/services + default-portfolio invariants (§6.8) | **T2 Opus xhigh** (migrations + ownership scoping) |
| Overview blocks (winners/losers, donuts, recent transactions), switcher placeholder, visibility toggle UI | T3 Sonnet high |
| Any change to `domain/holdings` or the value-over-time math while rescoping | **T1 Fable xhigh** |

### P4 — Workboard playground: Conglomerates + calculator
| Work | Tier |
|---|---|
| `domain/allocation` — the never-overshoot budget algorithm, edge cases, tests (§6.7) | **T1 Fable max** |
| Backtest wiring/regressions in `domain/backtest` (§6.6) | **T1 Fable xhigh** |
| **The Builder** — sliders/locks/auto-balance/normalize, autosave, debounced live preview (§6.5); flagship UX, gnarly frontend state | T2 Opus xhigh |
| Conglomerate CRUD, list/detail scaffolding, calculator UI + buy-flow dialogs, Workboard subnav + stubs | T3 Sonnet high |

### P5 — Social minimal
| Work | Tier |
|---|---|
| Friendship/visibility privacy boundaries: request flow without enumeration, friendship-scoped reads, instant revocation (§6.9, §10) + their tests | **T2 Opus xhigh** (privacy = security) |
| friend_requests/friendships migrations | T2 Opus xhigh |
| Friends/Shared-With-Me/My-Shared-Items pages, read-only portfolio view UI | T3 Sonnet high |

### P6 — Notifications & the email log
| Work | Tier |
|---|---|
| NotificationChannel dispatcher + event wiring, email_log semantics, retry/dedup (§6.10, §9) | T2 Opus xhigh |
| Gmail app-password transport preset, templates, bell/center UI, admin email-log views | T3 Sonnet high |

### P7 — Settings section
| Work | Tier |
|---|---|
| Security page (PIN management, sessions info) — touches auth | T2 Opus xhigh |
| Settings subnav, Account/Notifications pages, Coming-Soon placeholders | T3 Sonnet high |

### P8 — Admin global settings & registration modes
| Work | Tier |
|---|---|
| `app_settings` + registration-mode enforcement (closed enforced, others gated) (§6.12) | **T2 Opus xhigh** (access-control surface) |
| Admin Settings page UI, overview-card refresh | T3 Sonnet high |

### P9 — API `/docs`
| Work | Tier |
|---|---|
| OpenAPI generation from zod contracts + CI coverage gate (§6.13) | T2 Opus xhigh |
| `/docs` rendering page, docs content polish | T3 Sonnet high |

### P10 — Polish, e2e & v1 gate
| Work | Tier |
|---|---|
| Final visual/responsive design pass across the app | T2 Opus xhigh (strong design instincts; give it your palette or it defaults to its own) |
| Empty states, skeletons, Playwright e2e, deploy guide (both topology modes), disclaimers, backups | T3 Sonnet high |
| **Pre-release review:** `/code-review high` over the whole branch before tagging v1 | **T1 Fable xhigh** |

## Cross-cutting rules

1. **`domain/` is Fable territory, always.** Any file under `apps/api/src/domain/` (holdings, backtest, allocation; later alertEval) — first implementation at `max`, later edits at `xhigh`, never below T1. This is where a silent off-by-one costs real money.
2. **The provider/caching/coalescing/currency keystone and the local search-index core are T1.** `providers/` cache mechanics and `services/search` ranking/orchestration carry the owner's top complaints — same rule as domain code.
3. **Security floor is Opus.** Anything touching auth, sessions, PIN, rate limiting, account kinds, admin routes, registration modes, friendship/sharing privacy boundaries, tokens, or migrations never drops to T3 — not even "trivial" edits.
4. **Escalate instead of looping.** If the same bug survives two fix attempts, move up one tier (and effort) immediately. Three Sonnet retry loops cost more than one Fable turn.
5. **Plan deviations go through T1.** If implementation reveals PROJECTPLAN needs changing, discuss with Fable at `xhigh` and update the Decision Log (§16) before coding around it.
6. **Reviews:** quick `/code-review` per PR on whatever model the session runs; money-math PRs (domain code) additionally get a Fable review before merge.
7. **Unsure which tier? Take the higher one.** That's the policy, codified.
8. Subagents Claude Code spawns on its own (Explore etc.) pick their own cheaper models — leave them be.

## Expected cost vs. all-Fable

All-Fable-max for everything was estimated at ~$900–1,700 API-equivalent. This split lands around **$500–900** (over-speced on purpose), with the spend concentrated where it belongs: the P1 search/caching keystone, the P4 allocation core, and the P2/P5/P8 security boundaries.
