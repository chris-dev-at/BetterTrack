# TASK REPORT — Import B: row-kind classifier (fix round)

Branch: `sandbox/import-b-row-classifier` · Date: 2026-08-23
Scope: `apps/api/src/services/imports/rowClassifier.ts`, `rowClassifierAi.ts`, and their two test files.

Starting point: 8 failed | 33 passed (41). End point: **41 passed (41), 0 skipped, 0 failed** — typecheck (`tsc --noEmit`), ESLint and Prettier all clean.

## 1. Per-failure cause and fix

The 8 failures trace to 5 root causes. In every case I first asked whether the test or the implementation was wrong.

### RC1 — Positive quantity was read as a buy signal (implementation wrong)

**Failures fixed:** `stage 1 > never guesses a trade direction it has no signal for`.

`classifyByStructure` fell back `quantity > 0 ? 'buy'` when neither amount nor quantity sign existed. That guesses a direction from an unsigned magnitude: most brokers report quantity as a magnitude, so `+5` is equally consistent with buying 5 and selling 5. Only a NEGATIVE quantity is definitive (Trade Republic-style sold lots). This contradicted both the module's own philosophy ("a sign-less magnitude cannot separate money-out from bought-something") and its sibling test, which grants sell only for negative quantities.

**Fix (impl):** direction fallback is now `sign === 1 ? 'sell' : sign === -1 ? 'buy' : quantity < 0 ? 'sell' : null`; a positive quantity with no amount sign lands in the unknown/needsReview branch (evidence wording updated to match).

### RC2 — Stage 2 re-mined a kindHint stage 1 had already consumed (implementation wrong)

**Failures fixed:** `stage 1 > flags a kindHint that contradicts the structural trade reading` and `output contract > rounds confidence to two decimals and flags below a raised bar`.

`applyKeyword` built its haystack from `kindHint` + `text` unconditionally. Two bad consequences:

- _Conflict flip:_ the hint-conflict draft (`buy` @ 0.7 from structure vs hint `sell`) sits below the 0.8 bar, so stage 2 ran, matched the hint string `sell` as a keyword, and overwrote the verdict with the hint's own claim at 0.85 — erasing both the "structure wins" decision and the conflict flag.
- _Downgrade:_ a canonical hint verdict (`buy` @ 0.92) under a raised bar (0.93) was replaced by a generic 0.85 keyword echo of the same hint, so the test saw 0.85 instead of 0.92.

**Fix (impl):** `StageDraft` now carries `hintConsumed`, set wherever stage 1 trusted the hint structurally (hint-alone, conflict, cash-family branches). `applyKeyword` excludes a consumed hint from its haystack. Non-canonical hint values still join the haystack, exactly as the `ClassifiableRow` contract promises — nothing about stage 2's legitimate job changed.

### RC3 — Per-chunk index restart broke every batch after the first (implementation wrong)

**Failures fixed:** `stage 3 > batches up to aiMaxRowsPerCall and keeps classifying across chunks` (and it is why the chunk-2/3 labels came back `unknown`).

`classifyBatchWithAi` renumbered each batch from offset 0, but the prompt contract's `<index>` must stay attributable to the file's rows across chunks. Chunk 2 sent local indexes `0,1`; the scripted reply `2=withdrawal\n3=withdrawal` was then correctly rejected by the defensive parser as hallucinated indexes — the parser worked, the caller fed it a numbering the replies could never satisfy. The test's global numbering is the better contract (replies map to file rows in logs; the parser's out-of-range rejection still guards each call), so the implementation was fixed, not the test.

**Fix (impl):** batches carry their pool-global index into `AiBatchRow.index`; labels are applied by that index. First-chunk prompts are unchanged (global == local there).

### RC4 — Final confidence sweep flagged every successful AI verdict (implementation wrong)

**Failures fixed:** `stage 3 > sends N ambiguous rows in ONE call…`, `stage 3 > parses defensively around hallucinated indexes…`, `stage 3 > flags the remainder for review once the call budget is spent`.

The final loop applied `confidence < threshold ⇒ needsReview` to ALL rows. AI results carry a fixed NOMINAL score of 0.75 while the default bar is 0.8 — so every trusted model label was auto-flagged for review, making stage 3 paid review-flagging and defeating the cascade's cost-control point. Trust in AI output is already governed explicitly by `aiLowTrustResults` (that test pins the semantics).

**Fix (impl):** the sweep now exempts `stage === 'ai'` rows (rounding still applies to all rows; malformed/missing AI lines still go to needs-review with confidence clamped to 0.25).

### RC5 — Prompt text facts were quoted and not whitespace-collapsed (implementation wrong; one test expectation internally impossible)

**Failures fixed:** `batch prompt > lists indexed facts only, flattened and truncated` (rowClassifierAi.test.ts) and the prompt assertion inside `stage 3 > sends N ambiguous rows in ONE call…`.

`buildRowKindBatchPrompt` replaced quotes/newlines with spaces (leaving double spaces) and wrapped text in literal `"` quotes. The test itself asserts the whole prompt contains NO `"` character — so its own expected line `text="Kauf Markt Order 4711"` was unsatisfiable by ANY implementation. The coherent contract is the test's invariant: quote-free, whitespace-collapsed, truncated `key=value` facts (also removes any quote-injection vector into the reply format).

**Fix:** impl strips `"`/`\`, collapses `\s+`, truncates at 120 chars, emits unquoted. The two quoted expectations in the tests were corrected to the bare form (see §2).

## 2. Tests changed, and why (no test deleted, no assertion weakened)

1. `rowClassifierAi.test.ts > lists indexed facts only, flattened and truncated`
   - Expected line corrected from `3: text="Kauf Markt Order 4711" …` to `3: text=Kauf Markt Order 4711 …` — the old expectation was internally impossible (same test asserts `prompt).not.toContain('"')`). Justification above (RC5).
   - ADDED a truncation case (130-char memo): asserts the 120-char prefix reaches the model and the tail (`…sierra`) never does. The test's title promised truncation; nothing verified it. Purely strengthening.
2. `rowClassifier.test.ts > sends N ambiguous rows in ONE call…`
   - Prompt assertion corrected from `0: text="Booking reference 8842"` to `0: text=Booking reference 8842` — same RC5 contract; all other assertions untouched.

Everything else, including all four batching tests, the two defensive-parsing tests, and both stage-1 tests, passes against the ORIGINAL test code unchanged — the defects were in the implementation.

## 3. Latent defects also fixed (found by typecheck, not by vitest)

The previous run never ran `tsc`; three latent errors existed in these untracked files:

- `rowClassifier.ts`: `hintKind` was typed `string` via `ReadonlySet<string>.has()` narrowing — now a typed guard `toDirectHintKind(): DirectHintKind | null`.
- `rowClassifierAi.ts`: `match[1]`/`match[2]` possibly-undefined under `noUncheckedIndexedAccess` — now guarded explicitly.

## 4. Exact test output (real run, after fixes)

```
RUN  v3.2.6 /Users/cwiesi/.bettertrack-factory/opencode-sandbox/work/import-b-row-classifier/apps/api

 ✓ src/services/imports/__tests__/rowClassifierAi.test.ts (10 tests) 2ms
 ✓ src/services/imports/__tests__/rowClassifier.test.ts (31 tests) 6ms

 Test Files  2 passed (2)
      Tests  41 passed (41)
   Start at  04:59:38
   Duration  220ms (transform 45ms, setup 0ms, collect 62ms, tests 8ms, environment 0ms, prepare 87ms)
```

Skip count: **0 skipped** (vitest reports no skipped tests — none exist; the two files contain 41 tests total, all executed).

Command: `pnpm --filter @bettertrack/api exec vitest run src/services/imports/__tests__/rowClassifier.test.ts src/services/imports/__tests__/rowClassifierAi.test.ts`

## 5. Interface Task A (file parsing) must supply

```ts
interface ClassifiableRow {
  /** Memo / booking-type / note free text, or null. */
  text: string | null;
  /**
   * Hint column: canonical kind token (`buy | sell | dividend | deposit |
   * withdrawal | fee | tax`), family token (`trade | cash`), or anything else —
   * non-canonical values are mined as stage-2 keyword prose, never trusted.
   */
  kindHint: string | null;
  /** Signed where the source signs it; null when absent. Never coerce to 0. */
  quantity: number | null; // negative ⇒ sold lots (definitive); positive carries NO direction
  price: number | null;
  /** SIGNED amount in the file's currency when the source provides a sign. */
  amount: number | null; // sign drives trade direction and cash in/out
  symbol: string | null;
  isin: string | null;
}
```

Contract notes for Task A:

- Every field nullable; absent ≠ zero. A sign-less magnitude (amount or quantity) is treated as carrying NO direction — Task A must NOT fabricate signs.
- `amount` sign convention: positive = money in, negative = money out.
- `kindHint` casing is irrelevant (lower-cased internally); whitespace-trimmed.
- Output consumed downstream: `RowClassification { index, kind, confidence, stage, evidence, needsReview }` with locked wire kinds `buy | sell | dividend | deposit | withdrawal` plus internal-only `fee | tax | unknown` (always `needsReview: true`).
- AI is reached only via the injected `ImportRowAiSeam` (bound through `bindCheapTierAi(aiService, userId)`); Task A never touches a provider, and CHEAP tier only.

## 6. Constraint compliance

- AI only through `aiService.complete(userId, request)` — unchanged; the narrow `ImportRowAiSeam` + `bindCheapTierAi` seam is intact and still type-rejects the raw two-argument service.
- No live model calls: all tests run against the scripted stub seam (extra calls throw).
- CHEAP tier only: `ROW_CLASSIFICATION_AI_TIER = 'cheap'` pinned and tested.
- Model returns kind labels only; prompt carries facts, never values it may alter.
- Wire vocabulary unchanged (pinned by test).
- Model routing note: this fix round was executed inline on the owner's explicit instruction (fix-round on this session's own prior output in this directory, interactive), per CLAUDE.md rule 2; no redesign was performed.

## 7. Verification summary

- `pnpm --filter @bettertrack/api exec vitest run src/services/imports/__tests__/rowClassifier.test.ts src/services/imports/__tests__/rowClassifierAi.test.ts` → 41 passed (41), 0 skipped.
- `pnpm --filter @bettertrack/api typecheck` → clean.
- `pnpm exec eslint <the four files>` → clean; `pnpm exec prettier --check <the four files>` → clean.
- No other file in the repo imports the classifier (verified by grep), so there is no regression surface; the files are new/untracked.
