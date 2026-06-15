# BetterTrack

`PROJECTPLAN.md` is the source of truth for product behavior and architecture — read the relevant section before implementing; deviations go through the owner and get logged in §16 (Decision Log). `MODELUSE.md` defines which model tier runs which work.

## Model routing (binding)

Before implementing anything, classify the work per MODELUSE.md:

- **T1 — Fable**: `apps/api/src/domain/**` (allocation, backtest, holdings, alertEval) + their tests, the provider/caching/currency keystone, plan-deviation design decisions.
- **T2 — Opus**: auth/sessions/invites/admin, share tokens, import/export, DB schema/migrations, BullMQ jobs, realtime gateway/event bus, the Conglomerate Builder, design polish pass.
- **T3 — Sonnet at high effort (the floor)**: CRUD, plain UI pages, config/CI/compose, templates, e2e, docs. Nothing ever runs below this tier.

Rules:

1. **Self-contained work package above the session's model tier → delegate** to the matching project agent (`fable-core`, `opus-engineer`, `sonnet-builder`). Give the agent full context in the prompt: PROJECTPLAN section numbers, exact file paths, and acceptance criteria — it starts cold.
2. **Interactive work the user wants to watch → don't delegate.** If the session model is below the required tier, stop and ask the user to switch (`/model` + `/effort`) before writing code.
3. **Never write T1/T2 code inline on a lower-tier session model**, not even "just this once" or for a small fix.
4. **Escalate instead of looping**: a bug that survives two fix attempts moves up one tier immediately.
5. **When unsure which tier, take the higher one.**
6. Effort cannot be pinned on agents — for T1 first implementations the owner prefers a dedicated session at `/model` Fable + `/effort` max (see MODELUSE.md per-phase tables).
7. **Model-unavailability fallback (owner-authorized 2026-06-15, logged in PROJECTPLAN §16).** When a required tier's model is *unavailable* — e.g. Claude Fable 5 returning a "Mythos/access" gate rather than a transient error — the autonomous factory builds that tier's work on **Opus at maximum reasoning** instead of stalling, and reverts to the proper tier automatically once it is available again. This is the one sanctioned exception to rule 3, and **only** for genuine unavailability (never for convenience or speed). A build made under this exception must say so in the PR. Model-tier availability is never, by itself, grounds to mark an issue `needs-human`.
