# V5_KICKOFF.md — executing BetterTrack v5

> **Owner usage:** after v4 is signed off — fresh Claude Code session, `/model` Opus 4.8 (or the then-best available), `/effort` max, then say: _"Read factory/V5_KICKOFF.md and execute."_

## What this file is

Written 2026-07-07 by the Fable-5 Chief of Development (same day as the v4 kickoff), so v5 is also a finished design.

- **What v5 is:** `PROJECTPLAN.md` **§13.5** — v5 empties the §14 parking lot: everything not shipped in v1–v4 (owner decision 2026-07-07: "v5 will have all the features there are"). §14's prose remains the design-notes archive the §13.5 rows reference.
- **How to operate:** `factory/CHIEF.md` (role, heartbeats, endgame) + `factory/V4_KICKOFF.md` (stage model, prep checklist shape, incident playbook, environment map, owner-communication rules — all of it carries over verbatim with V4→V5 substituted). This file only states what is **different** for v5.
- Trust live state and memory over this file — it was frozen on 2026-07-07, two milestones early.

## The one hard difference: scope re-confirmation before prep

v5 was locked eight-plus factory-weeks before it runs. Between then and now sit the v4 gate, the Android app launch, and real public users — priorities will have moved. Therefore, **before Stage D prep**:

1. Assemble the confirmation menu in chat: every §13.5 phase as a numbered line, PLUS any §14 entries added since 2026-07-07, PLUS anything the v4 gate / app launch / user feedback surfaced. Mark your own recommended cuts/adds (★ convention).
2. Owner replies with numbers (add/cut). Silence on an item = it stays in.
3. Encode the delta as a §13.5 docs PR (row edits, §16 entry "V5 scope re-confirmed"), fill **V5-P0** from the v4-gate feedback, then prep exactly per the V4_KICKOFF Stage-D checklist with V5 substituted (PACK.md V5 brief, CHIEF.md mission line → V5, state reset, test.sh, labels, owner-items inventory; models.json stays owner-managed — never touch it).

## Stage detection (V4_KICKOFF table, substituted)

A: v4 still building → supervise per CHIEF.md. B: `check v4` open → endgame QA; close the gate issue the moment the owner signs off. C: `check v4` closed → feedback → V5-P0 + **the re-confirmation pass above**. D: prep → report ready → launch on owner go. E: supervise v5. F: `check v5` → endgame → sign-off → **after v5 the parking lot is empty: the next milestone is planned WITH the owner from scratch** (menu process; there is no V6_KICKOFF).

## v5-specific owner items (ask at the re-confirmation pass)

- **P12 (AI features):** an LLM API key + a monthly spend cap, or P12 gets cut. Env-gated + feature-flagged either way.
- **P13 (privacy modes):** owner-confirmed 2026-07-08 — BOTH arcs build: discreet mode (hide absolute amounts, show percentages) AND paranoid mode (hashed read-secret). No go/no-go needed; the paranoid-mode §16 design note before code still applies.
- **P2 (Grafana):** exposure decision — localhost-only on the Mac vs admin-proxied behind auth. Default localhost-only.
- **P4 (Germany tax):** confirm DE is still the wanted second country (a different market may have grown more relevant).
- **Play Store ops** (not factory): when the Android app ships, flip `mobile.bettertrack.at` placeholder → store redirect (edge config in `control_bettertrack_live/edge/`, one Chief ops task).

## v5-specific supervision notes

- **V5-P9 (expense tracking) is the largest arc** — the composer MUST split it into ≥3 dependent issues (import framework reuse → categorization+manager → dashboards+budgets). If it arrives as one issue, send it back via the checker.
- **V5-P1 (snapshot table) is the correctness-critical one** — its invalidation rules for backdated edits get a §16 design note BEFORE implementation, and its issues run at `diff:max`. Same for P4 (DE tax fixtures first) and P7 (collaborative-portfolio semantics note first).
- **P11 light theme** adds a light-mode sweep to the gate checklist — budget owner-eye time for it at Stage F.
- Sequencing freedom: P1–P5 are largely independent of P6–P13; let the composer parallelize across workers, but P0 first and P14 last as always.
- Estimate (pre-re-confirmation): **$350–650, 10–15 factory days, 2 workers.** Re-estimate after the confirmation pass and tell the owner before launch.

## Definition of done

`check v5` filed → endgame QA (public instance, DE + light-theme sweeps) → STABLE → owner sign-off → gate closed with feedback record → memory updated → propose the menu session for whatever comes next.
