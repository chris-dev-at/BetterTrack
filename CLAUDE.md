# BetterTrack

`PROJECTPLAN.md` is the source of truth for product behavior and architecture — read the relevant section before implementing; deviations go through the owner and get logged in §16 (Decision Log). `MODELUSE.md` expands the tiers below into the ladder, effort levels and per-phase mapping; **this block is authoritative on the tiers themselves** — if MODELUSE.md ever disagrees, this wins and MODELUSE.md gets corrected.

## Model routing (binding)

Before implementing anything, classify the work per MODELUSE.md:

- **T1 — Fable** (agent `fable-core`): the money math — `apps/api/src/domain/**` (allocation, backtest) **and** `packages/domain/src/**` (tax, holdings, cashLedger, seriesStats, settingsScope, vaultVectors; later alertEval) + their tests — plus the provider/caching/request-coalescing/currency keystone (§5.3), the local search-index core (§6.2), plan-deviation design decisions. The one-line re-export shims left in `apps/api/src/domain/` are T1 too.
- **T2 — Opus** (agent `opus-engineer`): auth/sessions/PIN/rate-limiting, account kinds, invites/admin + registration modes (§6.12), friendship/sharing privacy boundaries (§6.9), tokens, import/export, DB schema/migrations, BullMQ jobs, realtime gateway/event bus, the Conglomerate Builder, deployment-topology config (§11), design polish pass.
- **T3 — Sonnet at high effort (the floor)** (agent `sonnet-builder`): CRUD, plain UI pages, Coming-Soon placeholders, config/CI/compose, templates, e2e, docs. Nothing ever runs below this tier.

Fable is **not** retired — T1 is Fable. The owner's Fable-conservation policy (spend it only where T1 genuinely applies, one pass not a loop) is a **usage policy, not a tier change**: it never authorizes writing T1 code on a T2 model. See MODELUSE.md, "Fable availability & conservation".

Rules:

1. **Self-contained work package above the session's model tier → delegate** to the matching project agent (`fable-core`, `opus-engineer`, `sonnet-builder`). Give the agent full context in the prompt: PROJECTPLAN section numbers, exact file paths, and acceptance criteria — it starts cold.
2. **Interactive work the user wants to watch → don't delegate.** If the session model is below the required tier, stop and ask the user to switch (`/model` + `/effort`) before writing code.
3. **Never write T1/T2 code inline on a lower-tier session model**, not even "just this once" or for a small fix.
4. **Escalate instead of looping**: a bug that survives two fix attempts moves up one tier immediately.
5. **When unsure which tier, take the higher one.**
6. Effort cannot be pinned on agents — for T1 first implementations the owner prefers a dedicated session at `/model` Fable + `/effort` max (see MODELUSE.md per-phase tables).
