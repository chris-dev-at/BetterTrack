# FableBackExecute.md — Undo the Fable-outage fallback

**Audience: a future Claude Code session. DO NOT execute any of this unless the owner explicitly says** e.g. *"Fable is back — execute FableBackExecute.md"*. Until then this file is inert documentation.

## What this reverses

On **2026-06-15**, while Claude Fable 5 was unavailable (a "Mythos"/access gate, not a transient error), the build factory was adjusted so that **T1 (`tier:fable`) work builds on Opus at max reasoning** instead of stalling. Those adjustments were:

| # | File | Change to undo |
|---|------|----------------|
| 1 | `factory/run.sh` | Fable→Opus routing: `FABLE_UP`/`fable_up()`, `model_for()`, `issue_tier()`, the rewritten `tier_model()`, the per-loop `FABLE_UP=""` reset, and the pick-block fallback notify |
| 2 | `CLAUDE.md` | Routing **rule 7** (model-unavailability fallback) |
| 3 | `PROJECTPLAN.md` §16 | The `2026-06-15` Decision Log row |
| 4 | `factory/prompts/writer.md` | The **"Model note"** paragraph authorizing the Opus fallback |

> **Note — the factory already self-heals.** The routing in `run.sh` is dynamic: it probes Fable each cycle and, the moment Fable answers, `tier:fable` work runs on Fable again automatically — **no change is required for correct behaviour.** This runbook exists to remove the temporary *scaffolding and policy* so the repo reads as if the outage never happened, and to flag any T1 work that got built on Opus meanwhile.

## Preconditions

1. **Confirm Fable is actually back** (don't revert while it's still down):
   ```sh
   claude -p "Reply with exactly: ok" --model claude-fable-5 --output-format json \
     --dangerously-skip-permissions | jq '.is_error'
   ```
   Proceed only if this prints `false`. If it still mentions "Mythos"/unavailable, STOP — the fallback should stay.
2. You are in `~/projects/BetterTrack` on a clean working tree. Work on a branch (`git checkout -b factory/fable-restored`).

## Step 1 — `factory/run.sh`: restore Fable-first routing

Delete the Fable scaffolding block (the `# Is Fable usable this cycle?` block through `tier_model(){ model_for ... }`) and replace it with the original two-liner:

```bash
tier_model(){ case "$(gh issue view "$1" --json labels -q '.labels[].name' | grep '^tier:' || true)" in
  tier:fable) echo "$MF";; tier:sonnet) echo "$MS";; *) echo "$MO";; esac; }
```

Remove the per-loop reset line inside the `while true; do` loop:

```bash
  FABLE_UP=""   # re-probe Fable availability fresh each cycle   <-- delete this line
```

Replace the pick block:

```bash
  tier=$(issue_tier "$n"); m=$(model_for "$tier")
  [ "$tier" = "tier:fable" ] && [ "$m" = "$MO" ] && \
    notify "Fable unavailable — building tier:fable #$n on Opus"
  gh issue edit "$n" --add-label in-progress >/dev/null 2>&1 || true
  log "=== issue #$n (tier ${tier:-none}, model $m) ==="
```

…back to the simple version:

```bash
  gh issue edit "$n" --add-label in-progress >/dev/null 2>&1 || true
  log "=== issue #$n ==="
```

Keep `model_ok()` and `api_ok()` (they are generic capacity probes, not Fable-specific) and keep **all token-exhaustion handling** — that is NOT part of the Fable outage and must stay.

Sanity check: `bash -n factory/run.sh`, and confirm `grep -nE 'FABLE_UP|model_for|issue_tier|fable_up' factory/run.sh` returns nothing.

## Step 2 — `CLAUDE.md`: remove rule 7

Delete the bullet beginning **`7. **Model-unavailability fallback`** (the whole rule-7 paragraph). Rules 1–6 are unchanged.

## Step 3 — `PROJECTPLAN.md` §16: remove the outage entry

Delete the Decision Log row beginning `| 2026-06-15 | While Claude Fable 5 is unavailable, …`. (If you prefer to keep an audit trail, instead append a follow-up row `| <today> | Fable restored; outage fallback reverted (see FableBackExecute.md) | … |` — owner's choice.)

## Step 4 — `factory/prompts/writer.md`: restore the original

Remove the `**Model note (read first).**` paragraph and restore step 2 to its original wording:

```
2. If the issue is ambiguous, already done, or its acceptance criteria can't be met as written: comment your analysis on the issue, apply label needs-human and remove autopilot, and STOP. Do not open a PR you don't believe in.
```

(`factory/prompts/` is bind-mounted, so this takes effect on the next writer run without a rebuild.)

## Step 5 — Re-apply and restart

```sh
./factory/autorun.sh        # rebuild image (picks up run.sh) + restart the factory
```

The factory now routes `tier:fable` work to Fable again. Verify on the next pick of a `tier:fable` issue that the log shows `--model claude-fable-5`.

## Step 6 — Review any T1 work built on Opus during the outage

Each such PR states it in its body. Find them and decide per item whether to keep or re-implement on Fable:

```sh
gh pr list --state merged --search "Fable-outage exception in:body" --json number,title
# Known candidate: issue #8 (provider/caching/currency keystone). If it was built on
# Opus, consider a fresh tier:fable pass now that Fable is back.
```

To force a clean re-do of a kept-but-suspect issue on Fable: reopen/recreate it with the `tier:fable` + `autopilot` labels and let the factory rebuild it.

## Step 7 — Commit & merge

```sh
git add factory/run.sh CLAUDE.md PROJECTPLAN.md factory/prompts/writer.md
git commit -m "revert(factory): remove Fable-outage Opus fallback — Fable restored"
git push -u origin factory/fable-restored
gh pr create --base main --title "revert: Fable-outage Opus fallback (Fable restored)" --body "Reverses FableBackExecute.md adjustments now that Claude Fable 5 is available again."
# merge once CI is green
```

After merge, the repo reads as if the Fable outage never happened, and `FableBackExecute.md` itself may be deleted (or kept as a template for any future outage).
