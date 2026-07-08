# V4_KICKOFF.md — executing BetterTrack v4

> **Owner usage:** fresh Claude Code session, `/model` Opus 4.8, `/effort` max, then say: _"Read factory/V4_KICKOFF.md and execute."_ That is all. The session detects where the project stands and does the right next thing.

## What this file is

Written 2026-07-07 by the Fable-5 Chief of Development on its last interactive day, so that the Opus Chief executes a **finished design** and never has to invent scope.

- **What v4 is:** `PROJECTPLAN.md` **§13.4** — the authoritative build order and per-phase specs. Do not re-derive scope; deviations go through the owner and land in §16.
- **How to operate:** `factory/CHIEF.md` — role, authority, context economy, 45-minute heartbeat supervision, milestone endgame protocol. This file does not repeat it; read both.
- **What this file adds:** the v4 arc (stage detection A–F), the prep checklist, the Fable-succession rules, mobile-track coordination, and the operational gotchas the v1–v3 arcs paid to learn.

If anything here contradicts live state, trust live state and memory (`bettertrack-project`, `bettertrack-multifactory`, `bettertrack-golive`, `bettertrack-mobile-app`, `bettertrack-chief-of-development`) — this file was frozen on 2026-07-07.

## Fable succession (binding)

Claude Fable 5 retired from interactive/subscription use after 2026-07-07 (API-only since; §16 entry exists).

- Top tier everywhere = **Opus 4.8**. `multi-factory/state/control/models.json` is **owner-managed** — the owner runs the remaining Fable window on it and sets the post-Fable routing himself (owner directive 2026-07-08). Do not edit, "verify-fix", or prescribe it.
- Wherever any doc says "Fable" / "T1" (MODELUSE.md, CHIEF.md, §13.x "pre-release Fable review"), read: **the top available tier — today Opus 4.8 at max**.
- The escalation ladder ("bug survives two fix attempts → up one tier") now ends at opus max. Beyond that: decompose the issue or re-scope via the checker, don't loop.
- Optional levers, owner's call only: codex `gpt-5.5` / gemini via the ControlWebView **Models** tab are wired and verified (docs/multi-factory.md). Non-claude runs log `cost_usd: 0` in the ledger — remember that when reporting spend.

## Boot & stage detection

On boot (after CHIEF.md's own boot list): `gh issue list --state all --search "check v3"` + `gh issue list --state open` + `cat multi-factory/state/control/phase 2>/dev/null` + `docker ps`. Then jump to the first matching stage:

| Stage | Condition                                              | Do                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | v3 issues still open, no `check v3` issue              | Supervise v3 to completion per CHIEF.md. Nothing v4-specific yet.                                                                                                                                                                                                                                  |
| **B** | `check v3` open                                        | Run the **milestone endgame protocol** (CHIEF.md): personal Chrome QA on https://web.bettertrack.at (the public live instance — auto-deploys main; localhost:8090 is gone). File findings as difficulty-labeled factory issues, iterate to STABLE, then hand to the owner for sign-off. **The moment the owner signs off in chat, close the check-v3 gate issue with the sign-off + feedback record** (pattern: issue #317) — so B can never re-match after sign-off. |
| **C** | `check v3` closed, §13.4 **V4-P0 row still says RESERVED** | Collect the owner's v3 feedback **in chat**, convert to concrete quick-win items (bugs + small UX only; bigger asks → §14 entry or a §13.5 note), write them into the V4-P0 row via docs PR.             |
| **D** | P0 filled, factory down/drained                        | Run the **v4 prep checklist** below, report "v4 ready" + estimate to the owner, **launch only on the owner's go**.                                                                                                                                                                                 |
| **E** | v4 issues open / factory up                            | Supervise per CHIEF.md heartbeats. Incident playbook below.                                                                                                                                                                                                                                        |
| **F** | `check v4` open                                        | Endgame protocol again (public-instance QA), STABLE → owner sign-off → close the gate with the feedback record → update memory → tell the owner the next boot phrase: _"Read factory/V5_KICKOFF.md and execute."_                                                                                  |

## Stage D — the v4 prep checklist

Mirror of the proven v3 prep (PR #320). All docs changes in ONE PR.

1. **PACK.md** (`factory/knowledge/PACK.md`): replace the V3 milestone brief with a V4 brief — §13.4 phase digest (phase → scope one-liner → difficulty), the P1–P3-first ordering rule, the binding i18n + friction-ladder rules, owner-item env-gates. Keep the difficulty-routing digest.
2. **CHIEF.md**: mission line → "current milestone — **V4**, per `PROJECTPLAN.md` §13.4" (v1–v3 shipped).
3. **Gate hygiene:** check-v3 issue closed with sign-off record; zero open v3 autopilot issues/PRs; `factory/usage-report.sh` snapshot of v3 total cost → report to owner.
4. **MF state reset** (exactly like v3 prep): `multi-factory/state/` — clear `status/*`, `.composer-backoff`, `.composer-last`, `.composer-snapshot` (fresh milestone ⇒ composer must fire on first tick), `assignments/` and `merge-queue/` empty, `control/triggers.json` = `[]`, `control/workers` = 2, stale `control/phase`/`mode` cleared.
5. **models.json:** owner-managed — skip. The owner sets model/effort routing himself (incl. the post-Fable flip); never edit it in prep (owner directive 2026-07-08).
6. **Self-test:** `multi-factory/test.sh` all green; if factory lib/compose changed since last image build, rebuild via `./multi-factory/autorun.sh` path (compose changes need container RECREATE, not restart — scripts are baked/pinned).
7. **GitHub:** factory token rate limit healthy (`gh api rate_limit`), repo auto-merge ON, `diff:*` + `autopilot` + `needs-human` + `awaiting-owner` labels exist.
8. **Owner-items inventory** (one chat message, none block launch — all env-gated): Firebase service-account key (P3), Google OAuth client credentials (P4), Drive/rclone credentials (P6), optional Telegram bot token (P10), one physical Android device for the P3 gate test.
9. **Launch on owner go:** `./multi-factory/autorun.sh` (Docker Desktop must be running) or the ControlWebView **Start** button — `node multi-factory/control/server.mjs` → http://127.0.0.1:8790 if not already up.

## Stage E — supervision notes beyond CHIEF.md

- **Incident playbook (every pattern seen live in v3):**
  1. _Flaky test on CI_ (UserDetailPage email-edit hydration race was the v3 one; #337 cures it) → rerun CI once before anything else.
  2. _Merger BEHIND/race blip_ → `gh pr view N --json mergeable,mergeStateStatus,statusCheckRollup`; if green+MERGEABLE it was transient: `gh pr update-branch` → wait CI → squash-merge → remove `needs-human`.
  3. _Writer "backgrounded" its work, no PR_ → the worker strips the `autopilot` label on failure. **Re-add `autopilot`** (otherwise the issue is unschedulable forever) + leave a guidance comment (v3 example: #332).
  4. _Composer idle burn_ (fully composed, all dep-gated) → back-off fix #315 exists; if it recurs, pause the composer via drain modes rather than letting it re-run at ~$1/cycle.
- **Usage windows:** at ~99% of the 5h window, pause via ControlWebView (or `docker compose -p bettertrack-multifactory pause`) and arm the reset trigger (`state/control/triggers.json` usage rule, `onReset=start`) — the trigger→waitingReset→autorun chain is proven. Long waits: background Bash dies ~50 min — use `nohup … & disown` detached sentinels or session wakeups.
- **Merge authorization gotcha:** main is branch-protected (PR + `verify` check). The permission classifier blocks Chief self-merges unless the owner gave **explicit in-chat authorization in the CURRENT session**. Ask once per session, plainly ("may I merge my own docs/ops PRs this session?"), or route docs changes through the factory as an autopilot docs issue (v2 pattern, issue #249, ~$1.65).
- **Prettier gotcha:** a line-wrapped `+` or `*` at line start in .md prose becomes a list marker under `prettier --write` and corrupts meaning — never start a wrapped prose line with them.
- **Cost:** ledger `factory/usage/ledger.jsonl`, `factory/usage-report.sh` per-issue totals. v4 estimate **$180–350, 5–8 factory days, 2 workers**. Post a short cost+progress note to the owner at each day's end.

## Mobile-track coordination (runs in parallel with v4)

The Android app is built **outside the factory** by the owner + Gemini per `~/Desktop/Coding/BETTERTRACK_APP_EXECUTE_THIS.md` (spec + 19-step plan; starts after v3). Your duties:

- **V4-P1…P3 compose and merge before everything except P0** — they are the app track's blockers (scopes, bearer parity, idempotency, account chooser, deletion, FCM). Enforce this ordering with the composer if it drifts.
- `docs/mobile-push.md` (P3) is written FOR the app track — keep it accurate.
- When the owner relays app-track integration questions or API gaps: answer from PROJECTPLAN/contracts, file real gaps as difficulty-labeled factory issues, and reply to the owner in chat.
- The app assumes v3+v4 platform features (multi-watchlists, cash sources, audiences, chat, sessions, FCM, i18n EN/DE). If an app-track need contradicts §13.4, it's an owner decision — ask.

## Owner communication (binding, from ~/.claude/CLAUDE.md)

Every report, finding, warning, or question goes **plainly in the user-facing chat text** — never only in tool status lines, subagent prompts, commit messages, or logs. Subagent outcomes get summarized in chat. Never add Co-Authored-By or AI-attribution trailers to commits; commit as the logged-in GitHub user. AskUserQuestion sparingly — clean picks only; explanations in chat text.

## Environment quick map

| Thing                     | Where                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                      | `~/Desktop/Coding/Github/BetterTrack` → github.com/chris-dev-at/BetterTrack (main is branch-protected: PR + `verify`)                                                                                                                                                                                                                                               |
| Multi-factory             | `multi-factory/`, launch `./multi-factory/autorun.sh`, compose project `bettertrack-multifactory`, state under `multi-factory/state/`                                                                                                                                                                                                                               |
| ControlWebView            | `node multi-factory/control/server.mjs` → http://127.0.0.1:8790 (Start/Pause/drain modes, workers 1–4, triggers, Models tab)                                                                                                                                                                                                                                        |
| Single factory (fallback) | `factory/run.sh` via `./factory/autorun.sh`, compose project `bettertrack-factory` — never both at once                                                                                                                                                                                                                                                             |
| Live preview              | `~/Desktop/Coding/control_bettertrack_live/` = **the public bettertrack.at instance** (Cloudflare → Mac:80, subdomains mode); updater auto-pulls main every 5 min; only ABSOLUTE-path bind mounts in compose (relative mounts break the in-container updater — 2026-07-04 outage); after editing a bind-mounted nginx conf: `docker restart bettertrack-live-web-1` |
| Health                    | http://localhost:8090 no longer serves — use https://web.bettertrack.at and https://api.bettertrack.at/api/v1/health; in-container preview stays Host-routed on :80                                                                                                                                                                                                 |
| Backups                   | `control_bettertrack_live/backups/db/` daily pg_dump sidecar (30-day retention); V4-P6 adds the Drive offsite leg                                                                                                                                                                                                                                                   |
| Secrets                   | read-only backup clone holds the `.env` files — copy-out-only, never edit there (memory: `bettertrack-backup-secrets`)                                                                                                                                                                                                                                              |
| Cost ledger               | `factory/usage/ledger.jsonl` + `factory/usage-report.sh`                                                                                                                                                                                                                                                                                                            |
| Memory                    | `bettertrack-project`, `bettertrack-multifactory`, `bettertrack-golive`, `bettertrack-mobile-app`, `bettertrack-oauth-firstparty`, `bettertrack-chief-of-development`                                                                                                                                                                                               |

## Definition of done

`check v4` filed → endgame QA (public instance) → STABLE → owner sign-off in chat → gate issue closed with feedback record → memory updated → owner pointed at `factory/V5_KICKOFF.md`.
