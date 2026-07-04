# BetterTrack v1 — pre-release review (P10 gate)

Date: 2026-07-04 · Reviewed at: `main` @ `96c9846` · Gate issue: #195

## Verdict

**Blocked-by #216, otherwise ready.** The whole-branch Fable-tier review found exactly
one `[blocking]` defect: backtest previews return HTTP 500 for any basket containing a
non-EUR asset or the S&P 500 / MSCI World benchmark overlay, because the wired FX
source's `getHistoricalRate` is unimplemented and throws (#216, `tier:fable`). Every
other surface reviewed — money-math in `domain/**`, the §6.9 sharing/privacy
boundaries, auth/session/PIN/rate-limiting, the contracts↔API↔SPA drift surface, the
new P7–P9 UI, and both deployment topologies — is sound, with only minor hardening
findings, each filed as a follow-up issue below. Once #216 lands (with mixed-currency
and benchmark service tests), v1 is ready to tag.

## What was reviewed

- **Money-math (`apps/api/src/domain/**`)** — holdings cost-basis/P&L, oversell and
division-by-zero guards, value-over-time/net-flows FX handling, time-weighted return
(perf-% mode, #125), backtest normalization/clipping/carry-forward/metrics, and the
allocation never-overshoot invariant (verified bit-for-bit: the buy list is admitted
by the same summation that reports `totalCostEur`). Engine code is correct; the one
  blocking defect (#216) is in the FX-source composition, not the engine.
- **Sharing/privacy (§6.9)** — friendship AND visibility enforced per request in one
  SQL join; uniform 404s (no exists-oracle); no enumeration in `POST /social/requests`
  responses; unfriend/visibility-flip close access on the next request (no cached
  authorization); shared shape is `.strict()` with no transactions ledger and no email
  exposure. Backed by `social.sharing.test.ts` / `social.test.ts`.
- **Auth/session/PIN** — server-minted session ids rotated on login; signed
  httpOnly/lax cookies; app-wide CSRF guard mounted before every router; admin↔user
  isolation in both directions (403/404 asymmetry preserved); PIN capped at 5 attempts
  then password fallback; login timing equalized with a dummy argon2 verify;
  registration-mode `closed` enforced ahead of any account creation; invite tokens
  stored hashed; production argon2id at 64 MiB/t=3.
- **Contracts↔API↔SPA drift** — all 12 route files request-validated; every response
  mapper is an explicit field-pick (numeric-string and Date conversions verified); all
  11 SPA clients match mounted routes; the OpenAPI document's 71 endpoints diffed
  two-way against mounted routes with zero mismatches.
- **New P7–P9 surfaces** (Settings Account/Notifications/Security, Admin Settings,
  `/docs`, disclaimers) — loading/empty/error states and phone-width layout verified
  statically; route-level ErrorBoundaries confirmed wired in both apps; disclaimers
  mounted in the user footer and on the asset page.
- **Infra/deploy** — both nginx topology templates, the 5-service production compose
  (worker entry path matches the tsup output), migrations-before-up, backup
  rotation/restore docs, and every README command cross-checked against
  `env.ts`-required vars. Both modes boot on paper from the README alone (one caveat:
  #223 item 3).

## Quality gates on `main`

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` ✅ (673 passed, 3 skipped
  Redis-integration tests — expected without Docker) · `pnpm build` ✅
- CI on `main` green; nightly Playwright e2e green (run of 2026-07-04, per #213).
- Verified in this sandbox statically only (no Docker daemon): `docker compose up` in
  both modes, and backups — cross-checked file-by-file instead; live backup/restore
  evidence is in #189, live e2e evidence in #213.
- §13 happy path on a phone: verified statically (responsive patterns hold on every
  happy-path surface; no fixed-width/overflow hazards found). The automated e2e runs
  desktop-only today — #217 adds the phone-width project so the gate is machine-checked.

## Follow-ups filed

| Issue | Tier   | Severity     | Summary                                                                                                                                                                                         |
| ----- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #216  | fable  | **blocking** | Backtest preview 500s for any non-EUR asset or USD benchmark (historical FX source throws)                                                                                                      |
| #217  | sonnet | gate gap     | Playwright happy path has no phone-width viewport project                                                                                                                                       |
| #218  | fable  | minor        | Domain: lexicographic `executedAt` ordering (spurious `OversellError`), `monthsBefore` month-end rollover, TWR first-flow-day basis                                                             |
| #219  | opus   | minor        | Social: friend requests can target admin/disabled accounts; unthrottled request/decline loop; disabled owners keep sharing                                                                      |
| #221  | sonnet | minor        | Notifications UX: bell lacks loading/error states; mark-read errors silent; list vanishes on background refetch error                                                                           |
| #222  | sonnet | minor        | Admin shell missed the responsive pass (nav overflow at 375px, tap targets); Settings error lacks retry                                                                                         |
| #223  | sonnet | minor        | Infra/docs: dead rate-limit knobs in compose; restore doc leaves worker stopped; unconditional host-port binds; README TLS/`ADMIN_EMAIL` accuracy; nightly e2e uploads a nonexistent report dir |
| #224  | sonnet | minor        | Custom-asset category blind-cast can break the strict SPA parse; OpenAPI coverage gate only checks one direction                                                                                |

Accepted-design notes (no issue): per-account login-lockout DoS tradeoff (generic
responses preserved); non-Secure cookie on plain-HTTP ports mode (by design — TLS
guidance folded into #223); nginx templates lack websocket headers (matters only for
the post-v1 §4.5 realtime gateway).
