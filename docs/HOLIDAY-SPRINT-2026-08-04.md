# Holiday sprint — 2026-08-04 · owner return runbook

Everything the platform did while you were away, in the order you probably want it:
what shipped, where the mobile app got to, **what needs a decision from you**, the one
gate that must not be missed before an app release, and the state of the machine.

Written against `main` @ `b29f19b5`. Design decisions from this sprint are logged in
`PROJECTPLAN.md` §16 (four new rows, all dated 2026-08-04).

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

**Milestones done as of writing** (board `origin/main` @ `617acf4`):

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

## 3. OWNER DECISIONS WAITING

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
