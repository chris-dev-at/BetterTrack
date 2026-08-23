import type { ImportRowKind } from '@bettertrack/contracts';
import RE2 from 're2';

import {
  buildRowKindBatchPrompt,
  parseRowKindBatchReply,
  ROW_CLASSIFY_SYSTEM_PROMPT,
  type AiBatchRow,
  type ImportRowAiSeam,
  type RowClassificationAiLabel,
} from './rowClassifierAi';

/**
 * Row-kind classification for the import wizard (PROJECTPLAN.md §16
 * 2026-07-31): decide what each row IS, in a three-stage cascade, cheapest
 * first. Mixed content is the NORMAL case — one file may hold 20 cash movements
 * and 30 trades — so every row is classified INDEPENDENTLY on its own signals;
 * one odd row never poisons the file and is never coerced into a cash bucket.
 * The failure designed out here, verbatim: "it's not OH I ONLY UNDERSTAND CASH
 * TRANSACTIONS IN THIS FORMAT AND IF THERE IS 1 STOCK TRANSACTION I EITHER BREAK
 * OR ADD IT TO JUST A CASH WITHDRAW".
 *
 * Stages:
 * 1. **structure** — deterministic shape (quantity+price ⇒ trade; a canonical
 *    `kindHint`; the amount sign inside a known family). No AI, no text trust.
 *    Handles the majority at high confidence.
 * 2. **keyword** — a multilingual first-match-wins verb table over the row's
 *    text, evaluated through RE2 alternations (linear time, so no pattern can
 *    stall an import — same discipline as the expense rule engine). Text is a
 *    weaker signal than shape, so a trade verb ALONE never carries a row over
 *    the review bar: with no instrument evidence it stays provisional, and a
 *    cash word in the same text outranks it.
 * 3. **ai** — the CHEAP-tier fallback for the ambiguous remainder ONLY: batched
 *    into as few calls as the caps allow, parsed defensively, kind labels only
 *    (`rowClassifierAi.ts`).
 *
 * The wire vocabulary (`buy | sell | dividend | deposit | withdrawal`,
 * §13.4 V4-P8) is LOCKED. `fee | tax | unknown` are internal-only kinds for rows
 * that are not yet one of the five: they always carry `needsReview`, so they map
 * to an existing kind or get a human decision before they can ever be applied.
 */

// --- Input (the interface Task A hands us) ----------------------------------

/**
 * One parsed file row, as the file-parsing task hands it over. Pure data: every
 * field is nullable and the cascade treats absent signals as absent, never as
 * zero. `amount` is SIGNED in the file's currency when the source provides a
 * sign — a sign-less magnitude cannot separate "money out" from "bought
 * something", which is exactly the ambiguity this cascade refuses to paper over.
 */
export interface ClassifiableRow {
  /** Descriptive free text: memo, booking type, note — whatever Task A kept. */
  text: string | null;
  /**
   * Task A's hint column, expected to carry a canonical token (`buy`, `sell`,
   * `dividend`, `deposit`, `withdrawal`, `fee`, `tax`) or a family token
   * (`trade`, `cash`). Anything else degrades gracefully: the raw value joins
   * the stage-2 keyword haystack instead of being trusted structurally.
   */
  kindHint: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  symbol: string | null;
  isin: string | null;
}

// --- Output contract --------------------------------------------------------

/** The five locked wire kinds plus the internal-only fee/tax/unknown markers. */
export type ClassifiedKind = ImportRowKind | 'fee' | 'tax' | 'unknown';

export type ClassificationStage = 'structure' | 'keyword' | 'ai';

/** Per-row verdict. One per input row, same order, `index` = array position. */
export interface RowClassification {
  index: number;
  kind: ClassifiedKind;
  /** [0..1], rounded to two decimals. */
  confidence: number;
  stage: ClassificationStage;
  evidence: string;
  needsReview: boolean;
}

// --- Tunables ----------------------------------------------------------------

/** At or below this confidence a row is flagged for a human decision. */
export const DEFAULT_REVIEW_CONFIDENCE = 0.8;
/** Ambiguous rows per stage-3 call — a batch, never one call per row. */
export const DEFAULT_AI_MAX_ROWS_PER_CALL = 40;
/** Stage-3 call budget per import; overflow is flagged, never looped. */
export const DEFAULT_AI_MAX_CALLS = 3;

export interface ClassifyContext {
  /**
   * The bound CHEAP-tier seam (`bindCheapTierAi`). Omitted ⇒ stage 3 is disabled
   * and every ambiguous row stays `needsReview` — classification degrades to
   * stages 1–2 plus review, never to a guess.
   */
  ai?: ImportRowAiSeam;
  aiMaxRowsPerCall?: number;
  aiMaxCalls?: number;
  /**
   * Caller distrusts AI-derived kinds wholesale (e.g. the model failed a
   * calibration): well-formed replies still fill `kind`, but every AI-derived
   * result is flagged `needsReview`.
   */
  aiLowTrustResults?: boolean;
  reviewConfidenceBelow?: number;
}

// --- Stage 2 table -----------------------------------------------------------

interface KeywordGroup {
  kind: Exclude<ClassifiedKind, 'unknown'>;
  /**
   * Lowercase RE2 alternation, compiled once at module load. RE2 matching time
   * is linear — a pattern cannot backtrack an import into a stall (mirrors
   * `ruleEngine.compileRegex`). Static patterns cannot fail to compile, but an
   * inert group beats a crashed import, so the failure mode matches the expense
   * rule engine's.
   */
  pattern: RE2 | null;
}

function compileKeywordPattern(alternation: string): RE2 | null {
  try {
    return new RE2(alternation);
  } catch {
    return null;
  }
}

const KEYWORD_GROUPS: readonly KeywordGroup[] = [
  // Order IS semantics (first match wins). Cost markers outrank direction verbs:
  // a row whose text names a fee/tax is never itself a trade. `Verkauf` precedes
  // `Kauf` because substring matching must not read the sell out of a buy word
  // ("verkauf" contains "kauf") — RE2 has no lookarounds, ordering does the job.
  // Dividends precede deposits because "Dividendengutschrift" contains
  // "gutschrift". ASCII-transliterated umlaut variants are spelled out.
  {
    kind: 'tax',
    pattern: compileKeywordPattern('(kest|kapitalertragsteuer|quellensteuer|withholding)'),
  },
  {
    kind: 'fee',
    pattern: compileKeywordPattern(
      '(gebühr|gebuehr|provision|entgelt|depotgebühr|depotgebuehr|fee|charge|commission)',
    ),
  },
  {
    kind: 'sell',
    pattern: compileKeywordPattern('(verkauf|veräußerung|veraeusserung|sell|sale|sold|disposal)'),
  },
  { kind: 'buy', pattern: compileKeywordPattern('(kauf|buy|purchase|sparplan)') },
  {
    kind: 'dividend',
    pattern: compileKeywordPattern(
      '(dividende|dividend|ausschüttung|ausschuettung|distribution|coupon)',
    ),
  },
  {
    kind: 'deposit',
    pattern: compileKeywordPattern(
      '(einzahlung|gutschrift|überweisung|ueberweisung|zahlungseingang|deposit|credit|top-?up)',
    ),
  },
  {
    kind: 'withdrawal',
    pattern: compileKeywordPattern('(auszahlung|lastschrift|belastung|abbuchung|withdrawal|debit)'),
  },
];

/** Cash-family kinds whose implied direction a signed amount can contradict. */
const KEYWORD_EXPECTED_SIGN: Partial<Record<ClassifiedKind, 1 | -1>> = {
  deposit: 1,
  dividend: 1,
  withdrawal: -1,
};

/** Trade kinds — the ones that can only exist against an instrument. */
const KEYWORD_TRADE_KINDS: readonly ClassifiedKind[] = ['buy', 'sell'];

/** Cash kinds — the reading a gated trade row falls back to (see below). */
const KEYWORD_CASH_KINDS: readonly ClassifiedKind[] = ['deposit', 'withdrawal'];

/**
 * Stage-2 confidence for a trade VERB the row carries no instrument evidence
 * for. Deliberately below {@link DEFAULT_REVIEW_CONFIDENCE}: prose alone cannot
 * settle a trade, so the row joins the ambiguous pool and stage 3 (or a human)
 * decides. Same score as stage 1's "trade shape, no direction" — a real signal,
 * incomplete.
 */
const UNBACKED_TRADE_CONFIDENCE = 0.6;

interface KeywordHit {
  kind: KeywordGroup['kind'];
  matched: string;
}

/**
 * First match in {@link KEYWORD_GROUPS} order — table order IS precedence.
 * `only` narrows the scan to a subset of kinds WITHOUT reordering the table, so
 * a second pass (the gated-trade cash fallback) reads the same precedence the
 * unrestricted pass does.
 */
function matchKeywords(haystack: string, only?: readonly ClassifiedKind[]): KeywordHit | null {
  for (const group of KEYWORD_GROUPS) {
    if (only !== undefined && !only.includes(group.kind)) continue;
    const match = group.pattern?.exec(haystack)?.[1];
    if (match !== undefined) return { kind: group.kind, matched: match };
  }
  return null;
}

// --- Cascade -----------------------------------------------------------------

/** Sanitize a numeric field: non-finite parser output counts as absent. */
function num(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : null;
}

function hasInstrumentIdentity(row: ClassifiableRow): boolean {
  return nonBlank(row.symbol) !== null || nonBlank(row.isin) !== null;
}

/**
 * Any evidence that the row is ABOUT an instrument: a traded quantity, a price,
 * or an identity. Zero is not evidence — a quantity or price of 0 names no
 * instrument, exactly as stage 1 refuses to read a trade out of `quantity: 0`
 * (and exports that pad empty numeric columns with 0 must not slip past the
 * gate below).
 */
function hasInstrumentEvidence(row: ClassifiableRow): boolean {
  const quantity = num(row.quantity);
  const price = num(row.price);
  return (
    (quantity !== null && quantity !== 0) ||
    (price !== null && price !== 0) ||
    hasInstrumentIdentity(row)
  );
}

const DIRECT_HINT_KINDS = [
  'buy',
  'sell',
  'dividend',
  'deposit',
  'withdrawal',
  'fee',
  'tax',
] as const;

type DirectHintKind = (typeof DIRECT_HINT_KINDS)[number];

function toDirectHintKind(token: string): DirectHintKind | null {
  return (DIRECT_HINT_KINDS as readonly string[]).includes(token)
    ? (token as DirectHintKind)
    : null;
}

interface StageDraft {
  kind: ClassifiedKind;
  confidence: number;
  stage: ClassificationStage;
  evidence: string;
  needsReview: boolean;
  /**
   * True when stage 1 already consumed `kindHint` as a STRUCTURED signal.
   * Stage 2 must then exclude it from its prose haystack: re-mining the same
   * string would double-count one signal and — worse — let the hint outvote
   * the structural reading it already lost to (e.g. flip a conflicting-trade
   * verdict back to the hint's own claim).
   */
  hintConsumed?: boolean;
}

/**
 * Stage 1 — deterministic structure. High-precision rules only: anything this
 * stage asserts below the review threshold is explicitly provisional and left
 * for stage 2/3 to confirm or replace.
 */
function classifyByStructure(row: ClassifiableRow): StageDraft {
  const quantity = num(row.quantity);
  const price = num(row.price);
  const amount = num(row.amount);
  // Zero amounts carry no direction; ±0 collapses to "no sign".
  const sign = amount !== null && amount !== 0 ? (amount > 0 ? 1 : -1) : null;

  const hintToken = nonBlank(row.kindHint)?.toLowerCase() ?? null;
  const hintKind = hintToken !== null ? toDirectHintKind(hintToken) : null;
  const hintFamily = hintToken === 'trade' ? 'security' : hintToken === 'cash' ? 'cash' : null;

  // 1. quantity + price ⇒ trade family. Direction needs a SIGN: the amount
  //    sign when the source provides one, else a NEGATIVE quantity
  //    (Trade Republic-style sold lots). A POSITIVE quantity is not a buy
  //    signal — most brokers report unsigned magnitudes, so "+5" is equally
  //    consistent with buying 5 and selling 5; guessing buy there is exactly
  //    the coercion this cascade refuses.
  if (quantity !== null && quantity !== 0 && price !== null && price !== 0) {
    const direction = sign === 1 ? 'sell' : sign === -1 ? 'buy' : quantity < 0 ? 'sell' : null;
    let draft: StageDraft =
      direction !== null
        ? {
            kind: direction,
            confidence: 0.95,
            stage: 'structure',
            evidence: `quantity+price ⇒ trade; ${sign !== null ? 'amount' : 'quantity'} sign ⇒ ${direction}`,
            needsReview: false,
          }
        : {
            kind: 'unknown',
            confidence: 0.6,
            stage: 'structure',
            evidence:
              'quantity+price ⇒ trade, but neither an amount nor a negative quantity signs a direction',
            needsReview: true,
          };

    // 2. A canonical kindHint is declared intent — it classifies alone unless it
    // contradicts the structural trade reading (then structure wins, review).
    if (hintKind !== null) {
      if (draft.kind === 'unknown') {
        draft = {
          kind: hintKind,
          confidence: 0.92,
          stage: 'structure',
          evidence: `kindHint "${hintToken}"`,
          needsReview: hintKind === 'fee' || hintKind === 'tax',
          hintConsumed: true,
        };
      } else if (draft.kind !== hintKind) {
        draft = {
          ...draft,
          confidence: 0.7,
          evidence: `${draft.evidence}; conflicts with kindHint "${hintToken}"`,
          needsReview: true,
          hintConsumed: true,
        };
      } else {
        draft = { ...draft, hintConsumed: true };
      }
    }
    return draft;
  }

  // 3. A canonical kindHint without trade fields classifies alone.
  if (hintKind !== null) {
    return {
      kind: hintKind,
      confidence: 0.92,
      stage: 'structure',
      evidence: `kindHint "${hintToken}"`,
      needsReview: hintKind === 'fee' || hintKind === 'tax',
      hintConsumed: true,
    };
  }

  // 4. Declared cash family: the amount sign IS the decision.
  if (hintFamily === 'cash') {
    return sign !== null
      ? {
          kind: sign === 1 ? 'deposit' : 'withdrawal',
          confidence: 0.88,
          stage: 'structure',
          evidence: `cash kindHint "${hintToken}" + amount ${sign === 1 ? 'in' : 'out'}flow`,
          needsReview: false,
          hintConsumed: true,
        }
      : {
          kind: 'unknown',
          confidence: 0.5,
          stage: 'structure',
          evidence: `cash kindHint "${hintToken}" without an amount sign`,
          needsReview: true,
          hintConsumed: true,
        };
  }

  // 5. An identified asset paying in ⇒ most plausibly income (dividend), but a
  // bare positive amount is not proof — stay sub-threshold so stage 2 must
  // confirm before this passes unreviewed.
  if (sign === 1 && hasInstrumentIdentity(row)) {
    return {
      kind: 'dividend',
      confidence: 0.78,
      stage: 'structure',
      evidence: 'identified asset + positive amount ⇒ presumed payout',
      needsReview: false,
    };
  }

  // 6. A bare signed amount with no other signal. Sign alone cannot separate
  // "money out" from "bought something" — exactly the coercion the owner named —
  // so this verdict stays low-confidence on purpose.
  if (sign !== null) {
    return {
      kind: sign === 1 ? 'deposit' : 'withdrawal',
      confidence: 0.5,
      stage: 'structure',
      evidence: 'bare amount sign (no trade fields, asset, or hint)',
      needsReview: false,
    };
  }

  return {
    kind: 'unknown',
    confidence: 0.1,
    stage: 'structure',
    evidence: 'no usable structural signal',
    needsReview: true,
  };
}

/** Stage 2 override applied to a sub-threshold structure draft. */
function applyKeyword(row: ClassifiableRow, draft: StageDraft): StageDraft {
  // A hint stage 1 consumed structurally is NOT re-mined as prose here — see
  // {@link StageDraft.hintConsumed}. Non-canonical hint values still join the
  // haystack, exactly as the input contract promises.
  const haystack = [draft.hintConsumed === true ? null : nonBlank(row.kindHint), nonBlank(row.text)]
    .filter((part) => part !== null)
    .join(' ')
    .toLowerCase();
  // No hit (or nothing to scan): mark the row attempted-at-keyword; it lands in
  // the stage-3 pool unless a later stage resolves it.
  if (haystack === '') return { ...draft, stage: 'keyword', needsReview: true };

  const hit = matchKeywords(haystack);
  if (!hit) return { ...draft, stage: 'keyword', needsReview: true };

  // A trade VERB in free text is not a trade. "Gutschrift aus Verkauf Wohnung"
  // (an apartment) and "Auszahlung fuer Kauf Auto" (a car) are cash movements
  // that merely spell a direction verb; a buy/sell row naming NO instrument
  // cannot produce a holding, so booking it unseen is corrupt by construction.
  // Prose alone therefore never carries a trade over the bar — the row keeps a
  // provisional kind but drops into the ambiguous pool for stage 3/a human.
  const unbackedTrade = KEYWORD_TRADE_KINDS.includes(hit.kind) && !hasInstrumentEvidence(row);
  // …and when the gate fires, the CASH reading wins the tie-break: a genuine
  // trade carries an instrument, so with zero instrument evidence the cash word
  // in the same text is overwhelmingly the likelier reading. The flag alone is
  // not enough — a reviewer working through hundreds of flagged rows approves
  // the pre-filled default in bulk, so a WRONG default is how a flagged row
  // still becomes a wrong booking. Deterministic on purpose: this must hold
  // with no AI seam configured, since stage 3 is optional.
  // NOTE this is a tie-break INSIDE the gate, not a re-ranking of the table:
  // `verkauf` still precedes `kauf`, and a row WITH instrument evidence never
  // reaches this branch.
  const cashFallback = unbackedTrade ? matchKeywords(haystack, KEYWORD_CASH_KINDS) : null;
  const kind = cashFallback?.kind ?? hit.kind;
  const matched = cashFallback?.matched ?? hit.matched;

  const amount = num(row.amount);
  const signedSign = amount !== null && amount !== 0 ? (amount > 0 ? 1 : -1) : null;
  // Both checks read the RESOLVED kind: a substituted cash kind has to face the
  // same sign scrutiny the table's own cash hits do.
  const expectedSign = KEYWORD_EXPECTED_SIGN[kind];
  const signContradicts =
    expectedSign !== undefined && signedSign !== null && signedSign !== expectedSign;
  // Cash movements essentially never carry an instrument identity — a keyword
  // that says "cash" on a row naming an asset is suspicious enough to show a
  // human (guards e.g. bond or ETF names containing "credit").
  const cashKindWithAsset =
    (kind === 'deposit' || kind === 'withdrawal') && hasInstrumentIdentity(row);

  const notes: string[] = [];
  if (signContradicts) notes.push('contradicts the amount sign');
  if (cashKindWithAsset) notes.push('cash kind on a row carrying an asset identity');
  if (unbackedTrade) {
    const gate =
      'no instrument evidence — no quantity, price, symbol or ISIN names what was traded';
    notes.push(cashFallback !== null ? `trade keyword "${hit.matched}" ignored: ${gate}` : gate);
  }
  const internalOnly = kind === 'fee' || kind === 'tax';

  return {
    kind,
    confidence: unbackedTrade ? UNBACKED_TRADE_CONFIDENCE : 0.85,
    stage: 'keyword',
    evidence: `keyword "${matched}" ⇒ ${kind}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
    // Sub-threshold already forces review at the end of the cascade; stating it
    // here too keeps the invariant unconditional under a lowered review bar.
    needsReview: internalOnly || signContradicts || cashKindWithAsset || unbackedTrade,
  };
}

// --- Stage 3 -----------------------------------------------------------------

const AI_CONFIDENCE = 0.75;
const UNRESOLVED_CONFIDENCE = 0.25;

/**
 * One defensive batch call. Rows arrive with their POOL-GLOBAL index — the
 * prompt numbers rows by their position in the file (continuing across
 * chunks), so a reply stays attributable to the right row and the defensive
 * parser can reject out-of-batch hallucinations.
 */
async function classifyBatchWithAi(
  seam: ImportRowAiSeam,
  batch: readonly { index: number; row: ClassifiableRow }[],
): Promise<Map<number, RowClassificationAiLabel | null>> {
  const batchRows: AiBatchRow[] = batch.map(({ index, row }) => ({
    index,
    text: nonBlank(row.text),
    quantity: num(row.quantity),
    price: num(row.price),
    amount: num(row.amount),
    symbol: nonBlank(row.symbol),
    isin: nonBlank(row.isin),
  }));
  const validIndexes = new Set(batchRows.map((row) => row.index));
  const labels = new Map<number, RowClassificationAiLabel | null>();
  try {
    const reply = await seam.complete({
      system: ROW_CLASSIFY_SYSTEM_PROMPT,
      prompt: buildRowKindBatchPrompt(batchRows),
    });
    const parsed = parseRowKindBatchReply(reply.text, validIndexes);
    for (const batchRow of batchRows) {
      labels.set(batchRow.index, parsed.get(batchRow.index) ?? null);
    }
  } catch {
    // Provider unavailable/erroring: every row of the batch stays unresolved —
    // the real seam refunds the daily cap itself; we never retry here.
    for (const batchRow of batchRows) labels.set(batchRow.index, null);
  }
  return labels;
}

/**
 * Classify a whole file's rows. Returns exactly one {@link RowClassification}
 * per input row, in input order, `index` = position in `rows`. Never throws on
 * row content: an unusable row is `unknown` + `needsReview`, nothing more.
 */
export async function classifyRows(
  rows: readonly ClassifiableRow[],
  ctx: ClassifyContext = {},
): Promise<RowClassification[]> {
  const threshold = ctx.reviewConfidenceBelow ?? DEFAULT_REVIEW_CONFIDENCE;
  const maxRowsPerCall = Math.max(1, ctx.aiMaxRowsPerCall ?? DEFAULT_AI_MAX_ROWS_PER_CALL);
  const maxCalls = Math.max(0, ctx.aiMaxCalls ?? DEFAULT_AI_MAX_CALLS);

  const results: RowClassification[] = [];
  const pool: { index: number; row: ClassifiableRow }[] = [];

  for (const [index, row] of rows.entries()) {
    let draft = classifyByStructure(row);
    // Stage 2 runs whenever stage 1 could not clear the confidence bar.
    if (draft.confidence < threshold) draft = applyKeyword(row, draft);

    const resolved = draft.kind !== 'unknown' && draft.confidence >= threshold;
    if (!resolved) pool.push({ index, row });
    results.push({
      index,
      kind: draft.kind,
      confidence: draft.confidence,
      stage: draft.stage,
      evidence: draft.evidence,
      needsReview: draft.needsReview,
    });
  }

  // Stage 3: batched CHEAP-tier fallback for the ambiguous remainder ONLY —
  // spending a model call on a row stages 1–2 settled would be a bug.
  if (ctx.ai !== undefined && pool.length > 0) {
    let callsUsed = 0;
    let cursor = 0;
    while (cursor < pool.length) {
      const batch = pool.slice(cursor, cursor + maxRowsPerCall);
      cursor += batch.length;

      if (callsUsed >= maxCalls) {
        // Budget exhausted: flag the remainder for review rather than looping.
        for (const { index } of batch) {
          const flagged = results[index];
          if (flagged === undefined) continue;
          flagged.needsReview = true;
          flagged.evidence += '; ai call budget exhausted';
        }
        continue;
      }
      callsUsed += 1;

      const labels = await classifyBatchWithAi(ctx.ai, batch);
      for (const sent of batch) {
        const label = labels.get(sent.index) ?? null;
        if (label !== null) {
          results[sent.index] = {
            index: sent.index,
            kind: label,
            confidence: AI_CONFIDENCE,
            stage: 'ai',
            evidence: `ai ⇒ ${label}`,
            needsReview: ctx.aiLowTrustResults === true,
          };
        } else {
          // Malformed or missing line: needs-review, NEVER a guessed kind.
          const unresolved = results[sent.index];
          if (unresolved === undefined) continue;
          unresolved.needsReview = true;
          unresolved.confidence = Math.min(unresolved.confidence, UNRESOLVED_CONFIDENCE);
          unresolved.evidence += '; ai reply missing/malformed for this row';
        }
      }
    }
  }

  for (const result of results) {
    // The confidence bar calibrates the stages-1–2 heuristics. An AI verdict
    // is a label the model asserted at a fixed NOMINAL score (0.75) — sweeping
    // it under this bar would flag EVERY model answer and turn stage 3 into
    // paid review-flagging. Trust in AI output is governed explicitly by
    // `aiLowTrustResults` instead.
    if (result.stage !== 'ai' && result.confidence < threshold) result.needsReview = true;
    result.confidence = Math.round(Math.min(1, Math.max(0, result.confidence)) * 100) / 100;
  }
  return results;
}
