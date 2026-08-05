# Holiday sprint — 2026-08-04/05 · owner return runbook

Everything the platform did while you were away, in the order you probably want it:
what shipped, where the mobile app got to, **what needs a decision from you**, the one
gate that must not be missed before an app release, and the state of the machine.

**Day 1 (§1–§5) was written against `main` @ `b29f19b5`. Day 2 (§6–§8) is written
against `main` @ `bf160734` (2026-08-05 ~10:35Z) and is the current record.**

> **Read this first if you are short on time**
>
> - **§8 — check-v5 sign-off brief.** The audit verdicts in one place; this is your
>   decision input for issue **#1034**.
> - **§7 — owner decisions waiting.** The current list. **It supersedes §3.**
> - **§4 — prod redeploy gate.** Unchanged and still critical (migrations
>   `0079`/`0080`/`0081`).
> - **§6** is the day-2 record: what the factory merged overnight and what four review
>   streams filed.
>
> §1–§3 and §5 are the day-1 record, kept for the audit trail. Where day 2 changed
> something, the day-2 section says so.

Design decisions are logged in `PROJECTPLAN.md` §16 — **six rows dated 2026-08-04** (the
day-1 record said four; two more landed that evening via the AUD1 and HARD1 doc truth-ups)
and **one dated 2026-08-05** (the T1A storage-drift envelope extension, later corrected by
DOC2 / PR #1130).

---

## 1. What shipped

**Redesign**

- `da560413` (#1035) — Origin redesign round 3 wave 2: the demo's cash tab becomes one
  continuous liquidity workspace.

**Security**

- #1044 — the seven new production advisories were **fixed, not waived**
  (`socket.io-parser`, `ip-address` ×3, `fast-uri`, `hono`, `brace-expansion`). The
  significant one is an unauthenticated memory-exhaustion in the socket.io wire parser,
  which sits under the realtime gateway (§4.5). Four now-stale waivers were retired;
  twelve reviewed waivers remain.

**The mobile wave — 11 numbered PRs (MW1–MW11), plus one fix split out of MW5**

| PR    | What                                                                                        |
| ----- | ------------------------------------------------------------------------------------------- |
| #1045 | MW1 — installable PWA foundation: manifest, one unified service worker, offline shell       |
| #1047 | MW2 — phone-width navigation chrome for the user app                                        |
| #1050 | MW3 — mobile usability sweep A: portfolio, transactions, cash, wizard                       |
| #1051 | MW4 — mobile usability sweep B: workboard, social, settings, market                         |
| #1056 | MW5 — mobile-viewport e2e suite + horizontal-overflow gate                                  |
| #1046 | MW6 — `cash:read` / `cash:write` bearer surface (migration **0079**)                        |
| #1048 | MW7 — `mirrorchain:read` / `mirrorchain:write`, participation-only (migration **0080**)     |
| #1049 | MW8 — `vault:sync`, the bearer path for paranoid vault sync (migration **0081**)            |
| #1055 | MW9 — `privacyMode` on `MeResponse`, so a bearer client can pre-detect paranoid mode        |
| #1054 | MW10 — `docs/mobile-push.md` census delta: 11 undocumented notification types + digest push |
| #1061 | MW11 — asset-search result rows no longer overflow the 390 px viewport on long subtitles    |
| #1059 | Control Center header actions stay inside the phone sheet (product fix split out of #1056)  |

---

## 2. Mobile app sprint

The app lives in its own repo — **`chris-dev-at/BetterTrackMobile`** — and everything
platform↔app went through two files there:

- **`PLATFORM_ASKS.md`** — the board. Platform drops and app ticks, numbered.
  Latest exchange: **platform reply #41** (answers the app's asks #39/#40) and the app's
  **ack #42** (all four contract decisions adopted as written). The four blessings are
  also logged in `PROJECTPLAN.md` §16.
- **`docs/S3S4_STORAGE_PLAN.md`** — the storage-mode / Drive-autonomous architecture,
  work packages W1–W6, every claim path-cited.

**Milestones done as of the day-1 writing** (board `origin/main` @ `617acf4`). The app
moved a very long way on day 2 — **W4, W5, W6, S2c-1, S2c-2 and S5 all landed, and a
full-app redesign arc started.** See **§6.3** for the current state; the table below is
the day-1 snapshot.

| Milestone | Commit    | What                                                                              |
| --------- | --------- | --------------------------------------------------------------------------------- |
| S1 + S2a  | `dfb469a` | dev-backend hookup, runtime origin override, +4 scopes, defensive wire-compat     |
| S2b       | `fe3b45f` | cash edit/delete + fee kind, digest cadence + quiet hours, discreet mode, Room v6 |
| W1        | `4b24c6c` | storage-mode seam, per-origin v5 scope gating, Room v7                            |
| W2        | `396df43` | `packages/domain` port — holdings / seriesStats / settingsScope, vectors green    |
| W3        | `159cb48` | cashLedger port + `BTVAULT1` byte-conformance vs the published vectors            |

The board head at the time of writing is an owner directive to throttle up and
parallelize builders for ~10 h, so **re-read the board's latest commits before acting on
this section** — it will have moved.

Local clone used this sprint: `/private/tmp/bt-mobile-sprint`. Note it sits on
`sprint/v5-absorb`, which is **behind** `origin/main` — read the board from `origin/main`.

---

## 3. OWNER DECISIONS WAITING (day 1 — **superseded by §7**)

> **This list is out of date. Read §7 instead.** Every item below is still open and is
> carried forward verbatim into §7, which adds five more that day 2 produced. Kept here
> only so the day-1 record stays intact.

### 3.1 `check v5` sign-off — issue #1034

Still open, labelled `awaiting-owner`. It is the v5 gate; nothing composes V6 until it
closes.

### 3.2 Market-data provider for Drive-only mode

Direct-provider market data is **off by default** in the app's Drive-autonomous mode —
Yahoo-direct is a documented non-goal and it carries Play-Store ToS / Data-Safety
exposure. The app ships designed no-live-prices states, manual price entry, and an
opt-in "use BetterTrack for prices only" toggle. **A licensed provider, or an owner-run
price proxy, is your decision.** (Board ask #40 item 5.)

### 3.3 Google Cloud OAuth client for `at.bettertrack.app`

- Project: `bettertrackapp-c6996`
- Scope: `drive.appdata`
- Needs both the **release and debug SHA-1** fingerprints

**This gates the app's W4 device test** — the Drive path cannot be exercised on a real
phone until the client exists.

### 3.4 Vault `watchlist` entity kind

Deferred to you deliberately. `VAULT_ENTITY_KINDS` is a closed enum inside
`z.record(enum, …)`, so an unknown kind fails the **whole** vault document as
`document-invalid` — which reads to a user like corruption, not like the polite
`update-required`. Adding the kind therefore costs a **`schemaVersion` bump plus a web
reader migration**, which is too large to smuggle into a holiday sprint. The app runs
device-local watchlists labelled "stays on this device" in the meantime.

---

## 4. PROD REDEPLOY GATE — critical, do not skip

**Before any app release requests the new scopes, prod must be running v5 `main` with
migrations `0079`, `0080` and `0081` applied.**

The five new scopes are `cash:read`, `cash:write`, `mirrorchain:read`,
`mirrorchain:write`, `vault:sync`. Each is seeded onto the first-party BetterTrackMobile
client by an additive migration — `0079` cash, `0080` mirrorchain, `0081` vault:sync —
rather than by a seed script, precisely because the migration channel is the one prod
definitely runs.

**Why it matters:** an OAuth authorize that requests a scope the client has not been
granted is a hard reject, which kills the _whole login_, not just the feature. That is
the #423 / migration-0030 lesson from July, and it is why the gate exists.

**What protects you until then:** the app's own per-origin scope gating
(`v5ScopesEnabledFor()`) — non-prod backends request the widened set, prod keeps
requesting its proven 14 until the prod seed is confirmed. Login is safe today.

**What must happen:** when prod redeploys onto v5, **confirm it on the BetterTrackMobile
board** (`PLATFORM_ASKS.md`) so the app can flip prod over to the widened set. Nothing
else unblocks it, and the app will not flip without that tick.

> One correction to carry over: the board's note #39 item 4 and reply #41 both say
> "0079/0080". They predate #1049. **`0081` is now required too.**

---

## 5. Infra state

`/private/tmp` **does not survive a reboot.** Both worktrees below live there; if the Mac
has rebooted, they are gone and must be recreated with the same worktree + symlink
pattern.

**Factory**

- Shared state: **`~/.bettertrack-factory/state`** — outside the repo since 2026-07-31,
  so a branch switch cannot clobber a running factory. Mode `run-out`, phase `drained` at
  the time of writing.
- Never read `multi-factory/state.stale-20260731T2126Z` — it is a frozen copy that once
  cost an hour of believing the factory had stalled.
- Deploy worktree: **`/private/tmp/bt-factory-deploy-20260804`** @ `da560413`, with two
  symlinks that must exist for it to work at all:
  - `multi-factory/state -> ~/.bettertrack-factory/state`
  - `multi-factory/auth -> <Desktop repo>/multi-factory/auth`
- Control server: `node multi-factory/control/server.mjs` **from the deploy worktree**,
  listening on **`:8790`** (`MF_CONTROL_HOST=0.0.0.0` for LAN). No TLS, no login — keep it
  on trusted Wi-Fi only.

**Dev stack**

- Worktree: **`/private/tmp/bt-dev-stack-20260804`**, detached at `aee03a6c` (#1055) —
  the commit the mobile board ticked as the live dev backend.
- API on **`:3000`**, vite on **`:6771`** (the trusted origin).
- The demo login password is now **`myrandompass`** (used by `.dev-shot.mjs` /
  `.ux-shot.mjs` in the Desktop checkout).

**Credential vault**

- Still `multi-factory/auth/.claude-credentials/` **inside the Desktop repo** — gitignored
  and irreplaceable, so it stays off-limits to any `git clean` or `stash`. The 2026-07-31
  relocation moved only the _state_ half out of the repo; the auth half is still in there,
  which is why the deploy worktree needs both symlinks rather than one.

**One disclosure carried over from board reply #41:** during the app's 09:24–09:30 local
test window a platform-side agent interacted with the phone believing its own build was
installed. Nothing was installed over the app build and no logout happened, but
`svc power stayon usb` was set on the device and is **still set** — revert it if you don't
want it.

> **Day-2 delta to this section: see §6.4.** The dev-stack commit (`aee03a6c`) and both
> worktree paths below are still accurate as of 2026-08-05 ~10:35Z (re-verified); the
> factory did **not** stay drained — it ran all night. The phone is **off USB** and has
> been since 2026-08-04.

---

## 6. DAY 2 — 2026-08-04 evening → 2026-08-05 midday

Day 2 was: four review streams filing work over the merged mobile wave, and the factory
draining most of it overnight. Everything in this section is verified against `git log`,
`gh issue`/`gh pr` and the BetterTrackMobile board at the time of writing
(2026-08-05 ~10:35Z, `main` @ `bf160734`).

### 6.1 What the four review streams filed

**Stream 1 — burn-sprint review of the merged mobile wave (25 issues, filed
2026-08-04 20:12–22:10).** Not 24: the count below includes `HARD1`, which is easy to
miss because it is a batch rather than a numbered family.

| Family       | Issues                     | Status now                                                    |
| ------------ | -------------------------- | ------------------------------------------------------------- |
| SEC1–SEC3    | #1063, #1064, #1065        | **all merged**                                                |
| QA1          | #1066                      | **open** — see the note below                                 |
| PWA2         | #1067                      | merged                                                        |
| HARD1        | #1068                      | merged                                                        |
| UXB1–UXB11   | #1071–#1081                | UXB1–UXB10 merged; **UXB11 (#1081) open**, PR #1132 in flight |
| AUD1, AUD2   | #1084, #1085               | **both merged**                                               |
| A11Y1, A11Y2 | #1087, #1088               | **both open**, no PR in flight                                |
| PERF1–PERF4  | #1089, #1090, #1091, #1093 | **all four open**, no PR in flight                            |

**The QA1 exception is worth knowing about.** PR **#1082** (`task/1066`) was the QA1
implementation and it was **closed unmerged** on 2026-08-05 00:46Z. Its own populated
Chromium run surfaced narrow-layout failures the PR itself describes — long headings,
cash tag/filter rows, popup bounds, compact action headers — and those were split out
into **QA1a (#1101)** rather than suppressed. So the hardened mobile overflow gate is
**not** on `main`: #1066 and #1101 are both open. This is the one place in the wave where
a filed item went backwards rather than forwards.

**Stream 2 — T1 money-path audit of the domain engine (issues #1094–#1098).** Verdict
first: **no miscalculation was found anywhere.** What it did find were four
availability/consistency defects plus a nits batch — bugs that make correct numbers
_unreachable_ or _racy_, not wrong.

| Issue         | What                                                                                                                           | Status                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| T1A **#1094** | #917's storage-drift envelope missing from the holdings replay — stored 8-dp drift **permanently 500s the portfolio overview** | **merged**, PR #1103 (`af4b47f2`) |
| T1B **#1095** | `spendableAsOf` tie-ordering diverged from the cash write gate — preview lies, #378 auto-settle fails closed                   | **merged**, PR #1106 (`72ca1d03`) |
| T1C **#1096** | delete-with-tax-correction not atomic — a crash window leaves permanent locked residue in closed years                         | **merged**, PR #1107 (`5d9c7286`) |
| T1D **#1097** | cash-solvency check-then-write race                                                                                            | **merged**, PR #1109 (`1936adb1`) |
| T1E **#1098** | money-path nits: backdated-movement time anchors differ across the two cash dialogs                                            | **open**                          |

T1A shipped a new conformance vector file,
`packages/domain/src/__tests__/storageDriftVectors.ts` (added by `af4b47f2`, ships in the
built package), and the mobile Kotlin port re-pinned against it the same morning — its
harness independently flagged 5 of 622 vectors including the F1 repro, and closed them at
exact `0.0`. The §16 addendum for this is `PROJECTPLAN.md` (dated 2026-08-05).

> **One live discrepancy in the T1B paper trail, worth a correction rather than a fix.**
> The mobile-board tick announcing T1B describes the new tie-ordering as
> _"credits-before-debits at equal instants"_. **The merged code does not do that.**
> `orderCashMovements` (`packages/domain/src/cashLedger.ts:344-350`) sorts by timestamp
> then by **input index**, and `spendableAsOf` documents itself as using _"the gate's
> exact replay order, including input-order timestamp ties"_ (`:441`). The app team caught
> this independently, checked the vectors rather than the prose, and ported the vectors —
> which is the right outcome and exactly what the vector discipline is for. **The code and
> the conformance vectors agree; only the board prose is wrong.** Nothing is broken, but
> if credits-before-debits was the actual intent, that is a code change and a vector
> re-pin, not a wording fix.

**Stream 3 — standing-orders + intraday audit (issues #1116–#1121). All six are open.**

| Issue         | What                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| SO1 **#1116** | Resuming a monthly standing order books the already-passed anchor, against the documented no-back-fill contract                                    |
| SO2 **#1117** | Standing orders keep booking into **ARCHIVED** portfolios — PR #1131 in flight                                                                     |
| SO3 **#1118** | Deferred periods vanish silently: a `logger.warn` is the only trace, the service has no notify dependency at all                                   |
| SO4 **#1119** | Hardening batch: pause races, per-order error isolation, quote staleness, market-hours stamp                                                       |
| IN1 **#1120** | Intraday curve fabricates movement — needs re-anchoring of missing/pre-open buckets to prior close, and same-day trades applied at their timestamp |
| IN2 **#1121** | Intraday range batch: the 1M grid step must divide the day; `'1D'` should not plot two calendar days                                               |

This stream also surfaced **an owner decision it explicitly refused to make** — the
standing-order cash-leg model, parked in #1116's out-of-scope block. See **§7.5**.

**Stream 4 — post-merge review of the overnight wave (issues #1124–#1129), plus #1122.**

| Issue            | What                                                                                                            | Status               |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| PAR1 **#1122**   | The paranoid-enable wizard rate-limits itself                                                                   | **open**             |
| ORD1 **#1124**   | `listForAsset` has no `ORDER BY` — heap-order-dependent OVERSELL 400s and tax results on same-instant rows      | **open**             |
| GUARD1 **#1125** | Completeness guard: every API scope must be explicitly classified in the paranoid kill registry                 | **open**             |
| VLT1 **#1126**   | **Vault GET is unguarded for normal-mode accounts** — abandoned enable staging leaves ciphertext downloadable   | **open**             |
| SHR1 **#1127**   | **Audience widening is still open server-side** — legacy endpoints unconditionally overwrite narrower audiences | **open**             |
| MED2 **#1128**   | Medium batch: force-path lock bypass, 2FA throttle namespace, reset-timing depth, New-idea dead entry           | **open**             |
| DOC2 **#1129**   | §16 truth-up: T1A blast radius, envelope growth, board-ping status                                              | **merged**, PR #1130 |

**VLT1 and SHR1 are the two that matter for sign-off** — each is the unfinished half of a
bug whose other half already merged. VLT1 is the `GET` counterpart of SEC2 (#1064), which
closed the `PUT` on the same unguarded vault surface; SHR1 is the server-side counterpart
of UXB5 (#1075), which fixed only the client. §8 treats them as the gating pair.

### 6.2 What the factory merged overnight

**23 PRs merged between 2026-08-04T21:19Z and 2026-08-05T10:00Z**; **18** of them inside
the 22:00Z→08:20Z window specifically. (The mobile board's 10:35 CEST tick says "16" —
that was posted mid-flight and undercounts; the enumerated set below is authoritative.)

| Merged (UTC) | PR    | Merge SHA  | What                                                                                     |
| ------------ | ----- | ---------- | ---------------------------------------------------------------------------------------- |
| 08-04 21:19  | #1069 | `66071a1a` | UX-clarity sweep (pre-wave)                                                              |
| 08-04 21:43  | #1070 | `21460d79` | **SEC3** — consent page refused a paranoid account's whole first-party authorize         |
| 08-04 22:05  | #1086 | `c64725db` | **AUD1** — `PROJECTPLAN.md` §6.1 password-length text vs the shipped 8-char floor        |
| 08-04 22:37  | #1092 | `b3d442c0` | **PWA2** — SW cache growth on the vault origin, stale offline page, admin installability |
| 08-04 23:09  | #1083 | `2f0fedd1` | **SEC1** — paranoid mode did not kill the new bearer scopes; case-sensitive route guard  |
| 08-05 01:03  | #1100 | `b0272e4b` | **SEC2** — `vault:sync` PUT accepted on a non-paranoid account                           |
| 08-05 01:30  | #1102 | `10634907` | **HARD1** — bearer/PWA hardening + doc truth-up                                          |
| 08-05 01:50  | #1099 | `51149e04` | **UXB1** — global "+ Create" menu: 6 of 8 entries did nothing                            |
| 08-05 02:23  | #1103 | `af4b47f2` | **T1A** — storage-drift envelope extended to the holdings replay                         |
| 08-05 02:42  | #1104 | `8e6ca7ee` | **AUD2** — 2FA-disable throttle, TOTP replay guard, reset-timing equalization            |
| 08-05 03:05  | #1106 | `72ca1d03` | **T1B** — `spendableAsOf` tie-ordering                                                   |
| 08-05 03:28  | #1105 | `8b771eba` | **UXB2** — watchlists had no detail view                                                 |
| 08-05 04:02  | #1107 | `5d9c7286` | **T1C** — atomic delete-with-tax-correction                                              |
| 08-05 04:37  | #1108 | `75c4da3a` | **UXB3** — restored the "who/what you follow" page                                       |
| 08-05 04:57  | #1110 | `64cbf065` | **UXB4** — public share link shown once and never again                                  |
| 08-05 05:20  | #1109 | `1936adb1` | **T1D** — cash-solvency advisory lock                                                    |
| 08-05 05:58  | #1111 | `f281d28e` | **UXB5** — "Share with friends" overwrote a narrower audience (client half)              |
| 08-05 06:25  | #1112 | `84136de9` | **UXB6** — Control Center search matched panel titles only                               |
| 08-05 07:45  | #1113 | `2cc60950` | **UXB7** — mutations gave almost no success feedback                                     |
| 08-05 08:08  | #1114 | `16f7a289` | **UXB8** — ComingSoon CTA slot; `/portfolio/activity`                                    |
| 08-05 08:32  | #1115 | `fc970e8a` | **UXB9** — cash rules "Apply to existing" fired without confirm                          |
| 08-05 09:20  | #1130 | `871de0a5` | **DOC2** — §16 truth-up                                                                  |
| 08-05 10:00  | #1123 | `bf160734` | **UXB10** — disabled "New rule"/"New budget" reason                                      |

**Still in flight at the time of writing:** PR **#1131** (SO2, archived-portfolio
booking) and PR **#1132** (UXB11, naming consistency). Both open, neither merged.

### 6.3 Mobile app — day 2

The app repo (`chris-dev-at/BetterTrackMobile`) closed out its storage arc and started a
redesign arc. Verified against that repo's `origin/main`:

| Milestone | Commit    | What                                                                                                              |
| --------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| W4        | `ac316e1` | Drive-vault package — `DataHome`/`LocalDataHome`/`DriveDataHome` (REST+CAS), vault Room tables, `VaultOpExecutor` |
| W5        | `d91230f` | First-run storage wizard with verified round-trip vault creation, `VaultUnlockGate`, "Where your data lives"      |
| S2c-1     | `8da07e1` | Cash tags/budgets/rules UI, standing orders CRUD, `privacyMode` routing                                           |
| S2c-2     | `b1a09fb` | Market intel, comments+reactions, friend groups, mirrorchain UI, ideas, cash summary/trends                       |
| W6        | `8caf429` | Manual price entry, honest no-live-price states across 9 Drive-mode surfaces, opt-in BT-prices toggle             |
| S5        | `7bb5c8e` | `ServerVaultDataHome` over live `vault:sync` — CAS 412/ETag, 428, multi-medium sync, paranoid adoption path       |
| S5 E2E    | `f42b8c3` | **Live paranoid E2E, zero defects** — see below                                                                   |
| R1-A      | `2b7b0e9` | R-arc nav skeleton: 5-tab nav, 3-element top bar, badges to tab dots                                              |

**S5's live E2E is the notable one.** Against a real provisioned paranoid account on the
dev backend (`paranoid@bettertrack.local`), the app ran fetch → decrypt → hydrate →
project and reproduced **all 16 hand-derived numbers bit-for-bit** (cash `21,521.27`
included). Byte-compatibility is now proven against a browser-produced vault, not just
synthetic fixtures. Suite at `f42b8c3`: 2049 tests; at R1-A (`1a8f485`): **2072 tests**.

**The R-arc is a full-app redesign under Fable design direction**, started 2026-08-05
~10:50 CEST on your own verbatim words ("the top nav bar is way too cluttered… some pages
show you useless info first… completely rethink the nav"). The spec is `docs/R1_SPEC.md`
in the app repo; R1-A (nav skeleton + top bar) is merged and design-reviewed.

**Two decisions were taken on that board under holiday authority and need your ratification
or reversal — both are in §7.**

### 6.4 Infra — day 2 delta

- **Dev stack** — still `/private/tmp/bt-dev-stack-20260804` detached at **`aee03a6c`**
  (#1055). Re-verified at the time of writing. Postgres `:5432` and Redis `:6379` up.
- **A paranoid test account was provisioned on dev** through the real enable wizard and
  verified end-to-end (server purged to 0 plaintext rows, unlock round-trip proven):
  `paranoid@bettertrack.local`, with a vault passphrase and a `vault:sync` +
  `account:security` bearer API key. Credentials are posted **in clear on the mobile
  board**. See **§7.8** — this account needs rotating.
- **The factory did not stay drained.** It ran all night; §5's "mode `run-out`, phase
  `drained`" was true only at the day-1 writing.
- **The phone is OFF USB** and has been since the 2026-08-04 freeze. See **§7.9**.

---

## 7. OWNER DECISIONS WAITING — current list

This supersedes §3. Items 7.1–7.4 are carried forward from day 1 unchanged; 7.5–7.9 are
new from day 2.

### 7.1 `check v5` sign-off — issue #1034

**Open, labelled `awaiting-owner`, last updated 2026-08-01.** It is the v5 gate; nothing
composes V6 until it closes. **§8 is the brief written for this decision.**

### 7.2 Market-data provider for Drive-only mode

Unchanged from §3.2. Direct-provider market data is off by default in the app's
Drive-autonomous mode; Yahoo-direct is a documented non-goal with Play-Store ToS /
Data-Safety exposure. W6 shipped the honest degraded states, manual price entry and an
opt-in "use BetterTrack for prices only" toggle, so nothing is blocked — but **a licensed
provider, or an owner-run price proxy, is your call.**

### 7.3 Google Cloud OAuth client for `at.bettertrack.app`

Unchanged from §3.3. Project `bettertrackapp-c6996`, scope `drive.appdata`, needs both
release and debug SHA-1 fingerprints. This still gates the Drive path on a real phone.

### 7.4 Vault entity kinds — `watchlist` **and now `pricePoint`**

§3.4 described the `watchlist` kind. Day 2 added a **second** request of the same shape:
W6's Drive-mode manual prices currently live in a device-local price cache because
`customAssetValue` semantically cannot carry `AAPL`, so portable manual prices want a
`pricePoint`-style kind (board ask #55 item 3).

Both cost the same thing, which is why both are parked: `VAULT_ENTITY_KINDS` is a closed
enum inside `z.record(enum, …)`, so an unknown kind fails the **whole** vault document as
`document-invalid` — which reads to a user like corruption rather than the polite
`update-required`. Adding either kind costs a **`schemaVersion` bump plus a web reader
migration**. **Worth deciding both together**, since one schemaVersion bump can carry both.

### 7.5 NEW — the standing-order cash-leg model

**What the code does today** (`apps/api/src/services/standingOrders/standingOrderService.ts:55-56`,
verified): _"Buys never touch cash (they book only the BUY transaction at the current
quote)."_ A `cash-deduct` order checks solvency and defers rather than overdrawing; a
`buy-asset` order **executes regardless of cash balance** and books no cash movement.

**And the amount model compounds it** (`packages/contracts/src/standingOrders.ts:22-23`,
132, verified): `amount` is a **share quantity** for `buy-asset` and a EUR magnitude only
for the cash kinds. So _"€200 into AAPL every month"_ — the ordinary shape of a European
savings plan — **is not expressible today**; only _"0.5 shares every month"_ is.

**Why it is parked for you:** giving buys a cash leg, or adding EUR-denominated buys, is a
product decision with real consequences (existing orders' semantics, whether an
insufficient-cash buy defers or fails, what happens to portfolios with no cash source). The
audit deliberately declined to decide it and fenced it out of #1116's scope. **This is the
one genuinely product-shaped decision in this list.**

### 7.6 NEW — light theme for the mobile app

The R-arc mandate asked for "light+dark screenshots"; the app is **deliberately dark-only**
(single brand scheme). Fable ruled **light theme OUT of R-arc scope, dark-only stands**,
on the grounds that a light theme doubles every design decision and is an owner-scale call
— and put it on this list rather than into the arc. **Ratify or reverse.**

### 7.7 NEW — the top-bar switcher supersession (ratify or revert)

Your **2026-07-09** ask put the portfolio switcher in the top bar beside the wordmark.
Your **2026-08-05** words ("top nav bar way too cluttered") name that same bar. The board
treated the newer word as superseding the older one and **moved the switcher out of the
top bar into a collapsing Portfolio large-title header** — decided under holiday authority,
flagged explicitly by the app and confirmed explicitly by Fable so there is an audit trail.
**Reverting is one commit** if you disagree; the collapsing-header switcher is strictly
more capable either way.

### 7.8 NEW — rotate the paranoid dev account

The dev paranoid account's vault passphrase is posted in clear on the mobile board, and
**that vault contains the account's Ed25519 retirement-proof private key**. It is a dev
dummy on a local stack, so this is not an incident — but the credential should be rotated
after the sprint rather than left indefinitely. Flagged by the app team, not found by us.

### 7.9 NEW — plug the phone back in

The phone (`R5CN80ABXBK`) dropped off USB during the 2026-08-04 freeze and is **still
off**. This blocks two things at once: **R-arc screenshot review rounds** (Fable reviews
every round; R1 landed code-verified with gallery entries as interim proof only) and
**seven batches of queued device verification**. Replugging it, plus re-running
`adb reverse tcp:3000 tcp:3000`, unblocks both. **Lowest-effort, highest-unblock item on
this list.**

### 7.10 Parked LOW-perf items (informational — no decision needed unless you disagree)

**PERF1–PERF4** (#1089, #1090, #1091, #1093) are filed and open: the 2.7 MB single bundle
wants code-splitting, the workboard watchlist issues ~40 quote requests / 1.8 MB where ~2
would do, the cash-movements list is an unbounded full-ledger fetch, and there is a small
batch of query-client/realtime-invalidation tuning. **None is a correctness or security
issue**; the platform's recommendation is that they are post-sign-off hardening. Flagged
here only so you are not surprised that a v5 sign-off ships with them open.

---

## 8. check-v5 sign-off brief — issue #1034

**Purpose.** You asked for a v5 check. Four audit streams ran across 2026-08-04/05 —
auth core, money core, accessibility, performance — plus a post-merge review of the
overnight wave itself. This section puts every verdict in one place so #1034 is a decision
rather than an investigation. It is deliberately not a victory lap: the open risk is
enumerated in §8.5 with issue numbers you can check live.

Written against `main` @ `bf160734`.

### 8.1 Auth core — NO exploitable bypass found

The audit traced sessions, password/reset, TOTP/2FA, OAuth consent and grants, bearer
scopes, API keys, rate limiting and the paranoid kill rail. **It found no exploitable
bypass.** What it found were three hardening items on the TOTP/reset surface — a missing
per-account throttle on 2FA-_disable_, no TOTP replay guard inside the ±1-step acceptance
window, and a measurable timing delta on password-reset request that enabled user
enumeration despite a constant response body. **All three shipped** in AUD2 (#1085 →
PR #1104), and AUD1 (#1084 → PR #1086) reconciled the `PROJECTPLAN.md` §6.1 doc text with the shipped
8-character floor.

**Measured for this brief**, not quoted from the audit — 41 auth-surface test files
(`auth*`, `oauth*`, `twoFactor*`/`totp`, `session*`, `password*`, `pin`, `apiKey*`,
`rateLimit*`, `bearer*`, `paranoid*`):

```
Test Files  2 failed | 39 passed (41)
     Tests  2 failed | 670 passed (672)
  Duration  69.10s
```

The two failures were `Parse Error: Expected HTTP/, RTSP/ or ICE/` in
`bearerPlatform.test.ts` and `oauth.test.ts` — a supertest ephemeral-server flake under
parallel load, not a defect. Re-run in isolation:

```
✓ src/__tests__/oauth.test.ts (36 tests) 6110ms
✓ src/__tests__/bearerPlatform.test.ts (81 tests) 10399ms

Test Files  2 passed (2)
     Tests  117 passed (117)
```

So: **672/672 green**, two of them needing an isolated re-run. (An earlier note circulated
a figure of "223 tests" for this verdict; the scoped, reproducible set is the 672 above.)

**Three of the four security bugs the wave review found were paranoid-mode scope bugs**
(SEC1/SEC2/SEC3) — all merged. That is the honest shape of the result: the auth core
itself held, and the new bearer surface added days earlier is where the defects were.

### 8.2 Money core — NO miscalculation

**Every traced number is right.** The T1 audit of `packages/domain` found no
miscalculation anywhere. The four defects it did find (§6.1, stream 2) are
availability and consistency bugs — a correct number that 500s, a correct number computed
in an order that disagrees with the gate that enforces it, a correct number left in a
half-written state by a crash, a correct number racing another writer. All four merged.

The storage-drift envelope in particular was cross-checked by a **20,000-scenario
differential fuzz** proving the tax-side and holdings-side envelopes agree exactly.
**Caveat worth stating plainly: that fuzz was an audit-session artifact and is not
committed to this repo** — there is no fuzz harness under `packages/domain` or
`apps/api`. What _is_ committed and re-runnable is the conformance vector file
`packages/domain/src/__tests__/storageDriftVectors.ts` (the F1 drift fixture plus a
beyond-envelope oversell case). If you want the fuzz to be a standing gate rather than a
one-off, that is a small piece of work worth filing.

Independent corroboration: the mobile Kotlin port re-pinned its 622 vectors against this
`main`, its harness flagged 5 on its own including the F1 repro, and the literal port of
the envelope closed them at **exact `0.0`**.

`packages/domain` at `bf160734`:

```
Test Files  9 passed (9)
     Tests  443 passed (443)
```

### 8.3 Accessibility — strong baseline, gaps filed and **not yet fixing**

V5-P14 established a real baseline: muted-text contrast, link affordance and
reduced-motion coverage in the web app (#1020), the same for the landing site (#1008), and
a keyboard-operable admin user table (#1005).

The day-2 sweep filed two gaps: **A11Y1 (#1087)** — the origin overlay family
(`ODialog`/ControlCenter/Drawer/wizard) is not at a11y parity with `Dialog` — and
**A11Y2 (#1088)** — phone input-zoom, origin `Field` error wiring, touch targets, dialog
`describedby`, required markers.

**Correction to any summary that says these are "filed + fixing": they are filed only.**
Both are open with no PR in flight at the time of writing.

### 8.4 Performance — the conditional-request path works; the two big wins are filed

**The ETag/304 path is verified working**, and independently: the mobile app observed real
`304 Not Modified` responses with 0-byte bodies against `/portfolios/{id}` and `/history`
on the dev backend, and its S5 E2E confirmed `If-None-Match: "2"` → 304 on `GET /vault`.
Platform-side coverage is 20 tests across two `conditional.test.ts` files — including the
one that matters for a shared cache, that account B presenting account A's ETag gets a
**200, never a 304**.

The two real wins are filed and open: **PERF1 (#1089)** code-splitting the 2.7 MB single
bundle, and **PERF2 (#1090)** batching the workboard watchlist's ~40 quote requests /
1.8 MB down to ~2. Plus PERF3 (#1091, unbounded cash-movements fetch) and PERF4 (#1093,
small batch). See §7.10.

### 8.5 Remaining open risk — verified live at time of writing

Everything below is **open** as of 2026-08-05 ~10:35Z. Re-check with
`gh issue list --state open` before you decide; the factory was still merging.

**Security-relevant (the sign-off gate):**

| Issue            | Risk                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VLT1 #1126**   | Vault `GET` unguarded for normal-mode accounts — an abandoned enable staging leaves ciphertext downloadable. The `GET` counterpart of SEC2 (#1064), which closed the `PUT` on the same surface. |
| **SHR1 #1127**   | Audience widening still open server-side — legacy endpoints unconditionally overwrite narrower audiences. Server-side sibling of UXB5 (#1075), whose client half already merged.                |
| **GUARD1 #1125** | No completeness guard forcing every API scope to be explicitly classified in the paranoid kill registry — this is the guard that would have caught SEC1 structurally.                           |
| **MED2 #1128**   | Medium batch: force-path lock bypass, 2FA throttle namespace, reset-timing depth.                                                                                                               |

**Correctness-relevant:**

| Issue                            | Risk                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ORD1 #1124**                   | `listForAsset` has no `ORDER BY` — heap-order-dependent OVERSELL 400s and tax results on same-instant rows.                                                   |
| **T1E #1098**                    | Backdated-movement time anchors differ across the two cash dialogs.                                                                                           |
| **SO1–SO4, IN1–IN2 #1116–#1121** | Standing-order back-fill, archived-portfolio booking (PR #1131 in flight), silent deferred-period drops, plus intraday curve re-anchoring and range batching. |

**Operational / UX:**

| Issue                               | Risk                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PAR1 #1122**                      | The paranoid-enable wizard rate-limits itself. The §7 capture fires ~46 requests in one 10s window against a 60 req/10s burst limit on a _tiny_ account, and scales with portfolios × tax years — so a realistic account **fails its first enable attempt on a one-way destructive transition**, sees a generic "you're doing that too fast" banner, and each retry is punished harder by the escalation ladder. |
| **QA1 #1066 + QA1a #1101**          | The hardened mobile overflow gate is not on `main` (PR #1082 closed unmerged, §6.1).                                                                                                                                                                                                                                                                                                                             |
| **UXB11 #1081**                     | Naming consistency — PR #1132 in flight.                                                                                                                                                                                                                                                                                                                                                                         |
| **A11Y1 #1087, A11Y2 #1088**        | §8.3.                                                                                                                                                                                                                                                                                                                                                                                                            |
| **PERF1–4 #1089/#1090/#1091/#1093** | §8.4 and §7.10.                                                                                                                                                                                                                                                                                                                                                                                                  |

### 8.6 Recommendation

**v5 is sign-off-ready once the open security-relevant fixes merge — specifically the
VLT1/SHR1 class (#1126, #1127), with GUARD1 (#1125) and MED2 (#1128) alongside them.**
Everything else on the list is post-sign-off hardening.

The reasoning: the two audits that could have blocked a release came back clean on the
question that actually matters. Auth core has **no exploitable bypass**; money core has
**no miscalculation**. The defects that were found are real but bounded — availability,
consistency, and a new bearer surface that needed three scope fixes it has now had. VLT1
and SHR1 are the exception because they are _unfinished_ rather than _unfound_: both are
the server-side half of a bug whose client-side half already shipped, which is precisely
the state you do not want to sign off in.

**Two things that would make this recommendation stronger and are not yet true:** PAR1
(#1122) sits on a one-way destructive transition, which is a bad place for a
self-inflicted rate limit even though it is not a security hole; and the money-core fuzz
that backs §8.2's strongest claim is not a committed, re-runnable gate.

**One flag for your judgement, not a defect.** During day 2 the platform chief took
several decisions under holiday authority that are normally yours: the T1A envelope
extension (logged as an addendum to your existing #917 decision, `PROJECTPLAN.md` §16),
and the two mobile-board rulings in §7.6/§7.7. Each is documented with reasoning and each
is reversible. They are called out here because "the chief decided it while you were away"
is exactly the category you should re-read rather than inherit silently.
