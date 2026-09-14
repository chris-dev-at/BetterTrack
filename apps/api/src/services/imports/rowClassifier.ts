import type { ImportRowKind } from '@bettertrack/contracts';
import RE2 from 're2';

import {
  buildRowKindBatchPrompt,
  capCell,
  parseRowKindBatchReply,
  ROW_CLASSIFY_SYSTEM_PROMPT,
  type AiBatchRow,
  type RowClassificationAiLabel,
} from './rowClassifierAi';
import { importAiFailureOf, type ImportAiFailure, type ImportAiSeam } from './importAi';

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
 *    `kindHint`; the amount sign inside a known family). No AI.
 * 2. **keyword** — a multilingual first-match-wins verb table over the row's
 *    text, evaluated through RE2 alternations (linear time, so no pattern can
 *    stall an import — same discipline as the expense rule engine).
 * 3. **ai** — the model fallback for the ambiguous remainder ONLY: batched
 *    into as few calls as the caps allow, parsed defensively, kind labels only
 *    (`rowClassifierAi.ts`).
 *
 * **Stages 1 and 2 are not alternatives — stage 2 ALWAYS runs.** A structural
 * reading is a shape inference (quantity, price, an amount sign); the row's own
 * text is independent evidence, and a stage-1 verdict may not clear the review
 * bar while that evidence is unread. Concretely: `Dividendengutschrift …` with
 * quantity 100, price 0.412 and amount +41.20 has the exact shape of a sale and
 * would liquidate a position that was never sold. The two readings must AGREE,
 * or the row is flagged. Where they disagree the TEXT wins the default kind —
 * the amount SIGN is the weakest link in the chain (an unsigned `Betrag` column
 * inverts every trade in a file), while a DECLARED `kindHint` outranks both.
 * Two exceptions to "the text wins", both of them precision fixes:
 * a fee/tax word in the memo of a row that states a quantity AND a price is a
 * line item of that trade rather than the row's kind, and a `sniffFlags` entry
 * from the sniffer stops the row whatever the two readings agreed on.
 *
 * A second, orthogonal scan runs first: {@link NON_TRADE_MARKERS}. Storno
 * reversals, Depotüberträge, Kapitalmaßnahmen and Vorabpauschalen have trade or
 * cash SHAPE but are none of the five wire kinds. Booking them costs real money
 * (a reversal read as a buy doubles the position; a transfer-in read as a sale
 * fabricates a realized gain), and no model call can rescue a vocabulary that
 * has no word for them — so they are pinned to a human decision and never
 * reach stage 3.
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
   * Per-row issue kinds the SNIFFER raised for this physical line (`summary-row`,
   * `oversized-cell`, `header-width-mismatch`, …). Optional so existing callers
   * are untouched; when it is present and non-empty the row is forced to
   * `needsReview` and the flags are named in `evidence`.
   *
   * This exists because a row the sniffer already distrusted was reaching the
   * booking queue unattended: `31.01.2024;Summe Gutschrift;700,00` is a TOTALS
   * line, it sniffs as a `summary-row`, and this cascade — reading only the
   * text — resolved it to `deposit/0.85/needsReview:false`, i.e. the file's own
   * subtotal booked as a seventh deposit on top of the six it sums. The
   * classifier cannot see that from the row's content; the sniffer can, and its
   * doubt has to survive the hand-over instead of being dropped at the seam.
   *
   * Deliberately `string[]` rather than the sniffer's `TableIssueKind` union:
   * the flag names are DATA joined across a module boundary, and typing this
   * against the other module's enum would couple two independently-shipping
   * halves for no safety gain — an unrecognised flag must force review just as
   * loudly as a known one.
   */
  sniffFlags?: readonly string[];
  /**
   * Task A's hint column (`Typ`, `Auftragsart`, `Buchungsart`, `Transaction
   * type`, …). A canonical token — English (`buy`, `sell`, …) OR the German
   * vocabulary those columns actually carry (`Kauf`, `Verkauf`, `Dividende`,
   * `Ertrag`, `Einzahlung`, `Auszahlung`, `Sparplan`, `Zinsen`) — is trusted
   * structurally. Anything else degrades gracefully: the raw value joins the
   * stage-2 keyword haystack instead.
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
   * The bound import seam (`bindImportAi`). Omitted ⇒ stage 3 is disabled and
   * every ambiguous row stays `needsReview` — classification degrades to stages
   * 1–2 plus review, never to a guess.
   *
   * Every call here spends a unit of the caller's SHARED per-user daily AI
   * budget (§6.18 — one cap per user, not per feature), which is why the budget
   * below is small and why an exhausted cap stops the loop rather than
   * re-issuing guaranteed refusals.
   */
  ai?: ImportAiSeam;
  aiMaxRowsPerCall?: number;
  aiMaxCalls?: number;
  reviewConfidenceBelow?: number;
  /*
   * REMOVED: `aiLowTrustResults?: boolean`.
   *
   * It was declared here, documented at length as "a FLOOR that defaults true,
   * not a toggle", and never read by a single line of the implementation. Once
   * the standing ruling made every stage-3 row `needsReview` unconditionally
   * there was no direction left for the option to act in — `true` was the only
   * behaviour and `false` was silently ignored.
   *
   * A boolean on a security-relevant interface that a caller can set and that
   * does nothing is worse than no boolean: it reads as a protection being
   * enabled, it invites a future change to wire it up as a real toggle (which
   * would re-open exactly the hole the floor closed), and it makes the review
   * guarantee look negotiable when it is not. The guarantee is now stated only
   * where it is enforced, in `classifyRows`.
   */
}

// --- Text normalization ------------------------------------------------------

/**
 * German arrives in three spellings and the row text is not a lookup key we can
 * enumerate, so the HAYSTACK is normalized into both ASCII forms and every
 * pattern is written in ASCII only.
 *
 * This is a measured defect, not theory: `'VERÄUSSERUNG'.toLowerCase()` is
 * `veräusserung` — capital ß uppercases to SS, so the round trip produces a
 * spelling that matches NEITHER `veräußerung` NOR `veraeusserung`, and all-caps
 * German exports lost the sell verb entirely. Folding (`ä`→`a`, `ß`→`ss`) and
 * expanding (`ä`→`ae`, `ß`→`ss`) both map that string onto a listed
 * alternative, so all three spellings hit the same row of the table.
 */
interface Haystack {
  /** ä→a ö→o ü→u ß→ss, remaining diacritics stripped (`veräußerung` → `verausserung`). */
  folded: string;
  /** ä→ae ö→oe ü→ue ß→ss — the ASCII spelling German exports ship (`veraeusserung`). */
  expanded: string;
}

const EMPTY_HAYSTACK: Haystack = { folded: '', expanded: '' };

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalize ONE already-capped cell. Everything reaching this function comes
 * through {@link joinHaystack}, which is where {@link capCell} is applied — so
 * the two Unicode normalization passes and every RE2 scan downstream are
 * bounded by the sniffer's own analysis window rather than by the file.
 */
function toHaystack(raw: string): Haystack {
  // NFC first: a decomposed `a`+U+0308 from the file must still be seen as `ä`
  // by the expansion below, which matches the composed character.
  const lower = raw.normalize('NFC').toLowerCase();
  return {
    folded: stripDiacritics(lower.replace(/ß/g, 'ss')),
    expanded: stripDiacritics(
      lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'),
    ),
  };
}

/**
 * The single funnel every haystack in this module is built through, and
 * therefore the single place the cell cap has to hold.
 *
 * Each PART is capped independently, exactly as the sniffer caps each cell:
 * capping the joined string instead would let one oversized `kindHint` push the
 * row's `text` out of the analysed window entirely, which is a worse bug than
 * the cost it saves. See {@link capCell} for the measurement.
 */
function joinHaystack(parts: readonly (string | null)[]): Haystack {
  const joined = parts
    .filter((part) => part !== null)
    .map((part) => capCell(part))
    .join(' ');
  return joined === '' ? EMPTY_HAYSTACK : toHaystack(joined);
}

// --- Pattern compilation -----------------------------------------------------

/**
 * Terms that must start on a WORD BOUNDARY. German compounds are matched as
 * substrings on purpose (`Teilverkauf`, `Depotgebühr`, `Sparplanausführung` all
 * have to hit), but the short ENGLISH verbs are also substrings of ordinary
 * words and of security names, and an unanchored match there is a money bug:
 *
 * - `sell` inside **Gesellschaft** — `Ausschuettung Beispiel Gesellschaft mbH`
 *   with an ISIN and a positive amount resolved to `sell/0.85/unreviewed`,
 *   i.e. a dividend on a huge share of German securities liquidated the
 *   position instead of recording income. Measured, not hypothetical.
 * - `fee` inside **coffee**, `charge` inside **Recharge** (a top-up, the
 *   opposite direction).
 *
 * A leading boundary is enough for these: the collisions are all mid-word, and
 * legitimate suffixes (`selling`, `fees`, `charges`, `buyback`) must still hit.
 *
 * German compounds are on this list too when the SUFFIX position is where the
 * collision lives:
 *
 * - `ertrag` inside **Übertrag**, **Zinsertrag**, **Vertrag**. Added unanchored
 *   to the dividend group to fix `Ertragsgutschrift`, it re-created that fix's
 *   own defect one word over: the dividend group runs before deposit, so
 *   `Übertrag von Girokonto` +500, `Zinsertrag Tagesgeld` +12,50,
 *   `Bausparvertrag Einzahlung` +1000 and `Sparvertrag Gutschrift` +250 all
 *   resolved to `dividend/0.85/needsReview:FALSE` — cash movements booked as
 *   investment income, unattended, and `Zinsertrag` is the standard German term
 *   for the interest this module explicitly books as a `deposit`. `\bertrag`
 *   still catches `Ertrag`, `Ertragsgutschrift` and `Ertragsausschüttung`;
 *   `Kapitalertrag` is listed in full because the boundary is not there.
 * - `umtausch` inside **Waehrungsumtausch** / **Devisenumtausch**, routine
 *   multi-currency cash lines that a corporate-action marker pinned to a human
 *   decision and blocked from stage 3 entirely.
 */
const PREFIX_ANCHORED = new Set(['sell', 'buy', 'fee', 'charge', 'disposal', 'ertrag', 'umtausch']);

/**
 * Terms whose collision starts ON a boundary, so only a FULL word match is
 * safe: `sale` inside **Salesforce** (`Dividende Salesforce Inc` resolved to
 * `sell/0.85/unreviewed` — the same fabricated disposal), `sold` inside
 * **Soldat**. An optional plural keeps `sales` matching.
 *
 * The short corporate-action markers belong here for the same reason, and their
 * failure was worse than a wrong kind: a marker hit pins the row `unknown`,
 * sub-threshold, `tradeBlocked`, and INELIGIBLE for stage 3, so nothing
 * downstream can rescue it. Unanchored, `fusion` and `split` matched inside
 * ordinary security NAMES and destroyed genuine trades that carried a quantity,
 * a price and an ISIN — `Kauf Diffusion Pharmaceuticals Inc`, `Kauf Infusion
 * Brands Intl` and `Verkauf Splitit Payments Ltd` all fell from `buy`/`sell` at
 * 0.95 to `unknown` at 0.4–0.6.
 *
 * KNOWN AND ACCEPTED: a security whose name contains the marker as a WHOLE word
 * (`Fusion Fuel Green PLC`) still trips the marker. Separating "the memo says
 * Fusion" from "the instrument is called Fusion" needs a name/memo split this
 * module does not get, and the marker exists precisely because
 * `Kapitalmaßnahme Fusion` has perfect trade shape. Over-refusing one ticker is
 * the safe side of that trade; silently booking a corporate action is not.
 */
const WORD_ANCHORED = new Set(['sale', 'sold', 'fusion', 'split', 'merger']);

/** The regex source for one human-written term. */
function alternationSource(term: string): string {
  if (WORD_ANCHORED.has(term)) return `\\b${term}s?\\b`;
  if (PREFIX_ANCHORED.has(term)) return `\\b${term}`;
  return term;
}

/**
 * Lowercase ASCII alternation, compiled once at module load. RE2 matching time
 * is linear — a pattern cannot backtrack an import into a stall (mirrors
 * `ruleEngine.compileRegex`). Static patterns cannot fail to compile, but an
 * inert group beats a crashed import, so the failure mode matches the expense
 * rule engine's.
 */
function compileAlternation(alternatives: readonly string[]): RE2 | null {
  try {
    return new RE2(`(${alternatives.map(alternationSource).join('|')})`);
  } catch {
    return null;
  }
}

/** First alternative that hits, scanning the folded then the expanded spelling. */
function execAlternation(pattern: RE2 | null, haystack: Haystack): string | null {
  if (pattern === null) return null;
  return pattern.exec(haystack.folded)?.[1] ?? pattern.exec(haystack.expanded)?.[1] ?? null;
}

// --- Non-trade markers -------------------------------------------------------

/**
 * Terms that make a row NOT one of the five wire kinds, whatever its shape says.
 * Each of these has trade or cash shape and would otherwise book real money:
 *
 * - **reversal** — `Storno Wertpapierabrechnung Kauf` with quantity, price and a
 *   negative amount is structurally a perfect buy; booking it adds a SECOND
 *   purchase and doubles the position. Every German broker emits these. A
 *   reversal of ANY kind is wrong in the same way (a stornierte Einzahlung is
 *   not a deposit), so this marker voids the kind outright.
 * - **transfer** — `Depotübertrag Einbuchung` moves a position between
 *   custodians. Read as a sale it fabricates a realized gain, and read as a
 *   deposit it fabricates contributed capital.
 * - **corporateAction** — `Kapitalmaßnahme Umtausch/Fusion/Split` restates a
 *   holding; it is neither a purchase nor a disposal.
 * - **taxAccrual** — `Vorabpauschale` / `Thesaurierung`: a German advance
 *   lump-sum tax charge on an accumulating fund, whose per-unit "price" and
 *   share count read exactly like a trade.
 *
 * Marker rows are pinned sub-threshold, always `needsReview`, and deliberately
 * NEVER sent to stage 3: the model's vocabulary has no word for a reversal or a
 * corporate action, so a call could only produce a confident wrong answer.
 */
interface MarkerGroup {
  id: 'reversal' | 'transfer' | 'corporateAction' | 'taxAccrual';
  /** True ⇒ no kind survives at all (a Storno of a fee is not a fee). */
  voidsKind: boolean;
  alternatives: readonly string[];
  pattern: RE2 | null;
}

function markerGroup(
  id: MarkerGroup['id'],
  voidsKind: boolean,
  alternatives: readonly string[],
): MarkerGroup {
  return { id, voidsKind, alternatives, pattern: compileAlternation(alternatives) };
}

export const NON_TRADE_MARKERS: readonly MarkerGroup[] = [
  markerGroup('reversal', true, [
    'stornierung',
    'stornobuchung',
    'storno',
    'rueckbuchung',
    'ruckbuchung',
    'cancellation',
    'cancelled',
    'canceled',
    'reversal',
  ]),
  markerGroup('transfer', false, [
    'depotuebertrag',
    'depotubertrag',
    'depoteingang',
    'depotausgang',
    'einbuchung',
    'ausbuchung',
    'einlieferung',
    'auslieferung',
  ]),
  markerGroup('corporateAction', false, [
    'kapitalmassnahme',
    'corporate action',
    'umtausch',
    'fusion',
    'merger',
    'aktiensplit',
    'split',
  ]),
  markerGroup('taxAccrual', false, ['vorabpauschale', 'thesaurierung', 'thesaurierend']),
];

interface MarkerHit {
  group: MarkerGroup;
  matched: string;
}

function matchNonTradeMarker(haystack: Haystack): MarkerHit | null {
  for (const group of NON_TRADE_MARKERS) {
    const matched = execAlternation(group.pattern, haystack);
    if (matched !== null) return { group, matched };
  }
  return null;
}

// --- Stage 2 table -----------------------------------------------------------

interface KeywordGroup {
  kind: Exclude<ClassifiedKind, 'unknown'>;
  alternatives: readonly string[];
  pattern: RE2 | null;
}

function keywordGroup(kind: KeywordGroup['kind'], alternatives: readonly string[]): KeywordGroup {
  return { kind, alternatives, pattern: compileAlternation(alternatives) };
}

/**
 * Order IS semantics (first match wins). Cost markers outrank direction verbs: a
 * row whose text names a fee/tax is never itself a trade. `Verkauf` precedes
 * `Kauf` because substring matching must not read the sell out of a buy word
 * ("verkauf" contains "kauf") — RE2 has no lookarounds, ordering does the job.
 * Dividends precede deposits because `Ertragsgutschrift`, `Dividendengutschrift`
 * and `Ausschüttungsgutschrift` all contain `gutschrift`.
 *
 * Alternatives are ASCII only and cover BOTH German spellings (`gebuhr` folded /
 * `gebuehr` expanded) — see {@link Haystack}. Within a group, the more specific
 * alternative is listed first so `evidence` names the term a human would.
 */
export const KEYWORD_GROUPS: readonly KeywordGroup[] = [
  keywordGroup('tax', [
    'kapitalertragsteuer',
    'ertragsteuer',
    'quellensteuer',
    'withholding',
    'kest',
  ]),
  keywordGroup('fee', [
    'depotgebuehr',
    'depotgebuhr',
    'gebuehr',
    'gebuhr',
    'provision',
    'entgelt',
    'commission',
    // English exports concatenate the cost code into one token, where the
    // leading boundary `\bfee` needs is not there: `ACCOUNTFEE`, `MGMTFEE`,
    // `CUSTODYFEE` and `Servicefee` all fell through the fee group and resolved
    // on the amount sign alone as `withdrawal/0.5`. Enumerated rather than
    // matched as a `*fee` suffix on purpose — a suffix rule reads the fee back
    // out of **coffee**, which is the collision `\bfee` was introduced to fix.
    'accountfee',
    'managementfee',
    'mgmtfee',
    'custodyfee',
    'servicefee',
    'platformfee',
    'transactionfee',
    'brokeragefee',
    'charge',
    'fee',
  ]),
  keywordGroup('sell', [
    'verkauf',
    'veraeusserung',
    'verausserung',
    'disposal',
    'sell',
    'sale',
    'sold',
  ]),
  keywordGroup('buy', ['sparplan', 'purchase', 'kauf', 'buy']),
  keywordGroup('dividend', [
    'ertragsgutschrift',
    // Listed in full because `\bertrag` (see PREFIX_ANCHORED) has no boundary
    // to hook onto inside `Kapitalertrag`. `Kapitalertragsteuer` is unaffected:
    // the tax group is scanned first and claims it.
    'kapitalertrag',
    'ertrag',
    'dividende',
    'dividend',
    'ausschuettung',
    'ausschuttung',
    'distribution',
    'coupon',
  ]),
  keywordGroup('deposit', [
    // Interest is cash income with no instrument behind it. The four shipped
    // broker mappers all book it as an external deposit
    // (`mappers/tradeRepublic.ts` TYPE_MAP, `mappers/flatex.ts`); the classifier
    // states that convention explicitly instead of reaching it by accident
    // through the `gutschrift` in `Zinsgutschrift`.
    'zinsgutschrift',
    // …and `Zinsertrag`, the other standard German term for the same thing, is
    // named here rather than left to fall through: the dividend group above
    // used to swallow it whole via an unanchored `ertrag`, booking interest as
    // investment income at 0.85 unreviewed.
    'zinsertrag',
    'zinsen',
    'interest',
    'einzahlung',
    'zahlungseingang',
    'ueberweisung',
    'uberweisung',
    'gutschrift',
    'deposit',
    'credit',
    'top-up',
    'topup',
  ]),
  keywordGroup('withdrawal', [
    'auszahlung',
    'lastschrift',
    'belastung',
    'abbuchung',
    'withdrawal',
    'debit',
  ]),
];

/**
 * Every kind's implied cash direction. `deposit`/`dividend` are money IN,
 * `withdrawal` money OUT — and so are trades: a purchase pays money out, a sale
 * takes money in. Stage 1 treats that same sign as decisive proof of direction,
 * so stage 2 refusing to check it was a hole big enough to drive `Kauf VWCE`
 * with amount +9000 through at 0.85 unreviewed.
 */
const KEYWORD_EXPECTED_SIGN: Partial<Record<ClassifiedKind, 1 | -1>> = {
  buy: -1,
  sell: 1,
  deposit: 1,
  dividend: 1,
  withdrawal: -1,
};

/** Trade kinds — the ones that can only exist against an instrument. */
const KEYWORD_TRADE_KINDS: readonly ClassifiedKind[] = ['buy', 'sell'];

/** Cash kinds — the reading a gated trade row falls back to (see below). */
const KEYWORD_CASH_KINDS: readonly ClassifiedKind[] = ['deposit', 'withdrawal'];

/** The five kinds that can actually be booked; `fee`/`tax` are internal-only. */
const WIRE_KINDS: readonly ClassifiedKind[] = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal'];

/**
 * Stage-2 confidence for a trade VERB the row carries no instrument evidence
 * for. Deliberately below {@link DEFAULT_REVIEW_CONFIDENCE}: prose alone cannot
 * settle a trade, so the row joins the ambiguous pool and stage 3 (or a human)
 * decides. Same score as stage 1's "trade shape, no direction" — a real signal,
 * incomplete.
 */
const UNBACKED_TRADE_CONFIDENCE = 0.6;

/**
 * Two signals that read the same row differently, or a signal the amount sign
 * contradicts. Sub-threshold on purpose: the row keeps its likeliest kind but
 * cannot be booked unattended.
 */
const CONFLICTED_CONFIDENCE = 0.6;

/** A non-trade marker fired: pinned below the bar, human decision required. */
const MARKER_CONFIDENCE = 0.6;

/** A reversal voids the kind entirely — nothing survives to be confident about. */
const REVERSAL_CONFIDENCE = 0.4;

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
function matchKeywords(haystack: Haystack, only?: readonly ClassifiedKind[]): KeywordHit | null {
  for (const group of KEYWORD_GROUPS) {
    if (only !== undefined && !only.includes(group.kind)) continue;
    const matched = execAlternation(group.pattern, haystack);
    if (matched !== null) return { kind: group.kind, matched };
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

/** {@link capCell}, nullable. */
function capText(value: string | null): string | null {
  return value === null ? null : capCell(value);
}

/** At most this many sniffer flags are named in one row's evidence. */
const MAX_NAMED_SNIFF_FLAGS = 8;
/** At most this many characters of ONE flag name reach the evidence string. */
const MAX_SNIFF_FLAG_CHARS = 64;

/**
 * The sniffer's doubt about this row, rendered for `evidence` — or null when it
 * had none. A non-empty `sniffFlags` ALWAYS produces a note (and therefore
 * always forces review), even if every entry is blank: the array being non-empty
 * is the signal, and a flag we cannot name is not a flag we may ignore.
 *
 * Bounded on purpose. The flag names cross a module boundary and end up in a
 * string a reviewer reads, so neither their count nor their length is taken on
 * trust; duplicates collapse.
 */
function sniffFlagNote(row: ClassifiableRow): string | null {
  const flags = row.sniffFlags;
  if (flags === undefined || flags.length === 0) return null;
  const named: string[] = [];
  const seen = new Set<string>();
  for (const flag of flags) {
    // The `typeof` guard is not redundant at runtime even though the type says
    // it is: these values are DATA crossing a module boundary, and this module
    // promises never to throw on row content.
    const trimmed = typeof flag === 'string' ? flag.trim().slice(0, MAX_SNIFF_FLAG_CHARS) : '';
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    named.push(trimmed);
    if (named.length === MAX_NAMED_SNIFF_FLAGS) break;
  }
  const detail = named.length > 0 ? named.join(', ') : 'unnamed';
  return `the sniffer flagged this row (${detail}) — a human decides`;
}

function hasInstrumentIdentity(row: ClassifiableRow): boolean {
  return nonBlank(row.symbol) !== null || nonBlank(row.isin) !== null;
}

/**
 * Any evidence that the row is ABOUT an instrument: an identity, or a traded
 * quantity. Zero is not evidence — a quantity of 0 names no instrument, exactly
 * as stage 1 refuses to read a trade out of `quantity: 0` (and exports that pad
 * empty numeric columns with 0 must not slip past the gate below).
 *
 * A PRICE is deliberately not evidence on its own. `price` is whatever slice A's
 * column mapper put there, and an FX rate, a `Saldo` or a closing price all land
 * in that slot: `Auszahlung fuer Kauf Auto` correctly gates at
 * `withdrawal/0.6/review`, but one stray `price: 1.0912` used to flip it to
 * `buy/0.85/unreviewed`. A number with no identity and no share count does not
 * name an instrument.
 */
function hasInstrumentEvidence(row: ClassifiableRow): boolean {
  const quantity = num(row.quantity);
  return hasInstrumentIdentity(row) || (quantity !== null && quantity !== 0);
}

/**
 * Canonical hint tokens. Slice A maps the German `Typ` / `Auftragsart` /
 * `Buchungsart` columns into `kindHint` and ranks them by a GERMAN word set
 * (`columnMapping.ts` KIND_WORDS), and the four shipped broker mappers translate
 * exactly these values — so accepting English tokens only left the 0.92
 * "declared intent" path dead for the files it was built for. Keys are matched
 * against the folded AND expanded spelling of the hint, so `Ausschüttung`,
 * `Ausschuettung` and `AUSSCHÜTTUNG` all land here.
 *
 * `zinsen` → `deposit` mirrors `mappers/tradeRepublic.ts`: cash interest has no
 * instrument behind it and the repo books it as an external deposit.
 */
const DIRECT_HINT_TOKENS: Readonly<Record<string, ClassifiedKind>> = {
  buy: 'buy',
  kauf: 'buy',
  ankauf: 'buy',
  zukauf: 'buy',
  purchase: 'buy',
  sparplan: 'buy',
  savings_plan: 'buy',
  sell: 'sell',
  verkauf: 'sell',
  teilverkauf: 'sell',
  verausserung: 'sell',
  veraeusserung: 'sell',
  sale: 'sell',
  dividend: 'dividend',
  dividende: 'dividend',
  ertrag: 'dividend',
  ertragsgutschrift: 'dividend',
  ausschuttung: 'dividend',
  ausschuettung: 'dividend',
  distribution: 'dividend',
  deposit: 'deposit',
  einzahlung: 'deposit',
  zinsen: 'deposit',
  zinsgutschrift: 'deposit',
  interest: 'deposit',
  topup: 'deposit',
  'top-up': 'deposit',
  withdrawal: 'withdrawal',
  auszahlung: 'withdrawal',
  fee: 'fee',
  gebuhr: 'fee',
  gebuehr: 'fee',
  spesen: 'fee',
  provision: 'fee',
  tax: 'tax',
  steuer: 'tax',
  kest: 'tax',
  kapitalertragsteuer: 'tax',
  quellensteuer: 'tax',
};

function toDirectHintKind(token: Haystack): ClassifiedKind | null {
  return DIRECT_HINT_TOKENS[token.folded] ?? DIRECT_HINT_TOKENS[token.expanded] ?? null;
}

/** Family tokens: not a kind, but a declared bucket the amount sign can resolve. */
const CASH_FAMILY_HINTS = new Set(['cash', 'bar', 'geld']);

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
  /**
   * A high-precision structural reading (trade shape, canonical hint, declared
   * cash family). These are CORROBORATED against the keyword table rather than
   * replaced by it. Everything else falls through to stage 2 outright.
   *
   * Deliberately not "confidence >= threshold": a caller that lowers the review
   * bar must not thereby stop stage 2 from resolving weak rows.
   */
  decisive?: boolean;
  /** The kind came from a DECLARED hint column, not inferred from an amount sign. */
  declared?: boolean;
  /**
   * Stage 1 read a non-zero QUANTITY and a non-zero PRICE on this row, i.e. the
   * row states how many units at what each. That is the strongest instrument
   * evidence the file can carry, and it survives into stage 2 because a cost
   * word in the memo of such a row describes a LINE ITEM of the trade, never
   * the row's kind — see {@link corroborate}.
   */
  tradeShape?: boolean;
}

/** Everything the cascade knows about one row after the deterministic stages. */
interface RowVerdict {
  kind: ClassifiedKind;
  confidence: number;
  stage: ClassificationStage;
  evidence: string;
  needsReview: boolean;
  /**
   * A deterministic stage PROVED this row cannot be a trade (no instrument
   * evidence, or a non-trade marker). Stage 3 may not relabel it `buy`/`sell`:
   * a model verdict cannot conjure the instrument the row does not name.
   */
  tradeBlocked: boolean;
  /**
   * Whether stage 3 may look at this row at all. False for marker rows — the
   * five wire labels contain no answer for a Storno or a Kapitalmaßnahme, so a
   * call could only buy a confident wrong one.
   */
  aiEligible: boolean;
}

/**
 * Stage 1 — deterministic structure. High-precision rules only: anything this
 * stage asserts below the review threshold is explicitly provisional and left
 * for stage 2/3 to confirm or replace.
 */
function classifyByStructure(row: ClassifiableRow, hint: Haystack): StageDraft {
  const quantity = num(row.quantity);
  const price = num(row.price);
  const amount = num(row.amount);
  // Zero amounts carry no direction; ±0 collapses to "no sign".
  const sign = amount !== null && amount !== 0 ? (amount > 0 ? 1 : -1) : null;

  const hintLabel = hint.folded === '' ? null : hint.folded;
  const hintKind = hintLabel !== null ? toDirectHintKind(hint) : null;
  const cashFamilyHint = hintLabel !== null && CASH_FAMILY_HINTS.has(hint.folded);

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
            decisive: true,
            tradeShape: true,
          }
        : {
            kind: 'unknown',
            confidence: 0.6,
            stage: 'structure',
            evidence:
              'quantity+price ⇒ trade, but neither an amount nor a negative quantity signs a direction',
            needsReview: true,
            tradeShape: true,
          };

    // 2. A canonical kindHint is declared intent — it classifies alone, and it
    // OUTRANKS a direction the amount sign merely implied.
    if (hintKind !== null) {
      if (draft.kind === 'unknown') {
        draft = {
          kind: hintKind,
          confidence: 0.92,
          stage: 'structure',
          evidence: `kindHint "${hintLabel}"`,
          needsReview: hintKind === 'fee' || hintKind === 'tax',
          hintConsumed: true,
          decisive: true,
          declared: true,
          tradeShape: draft.tradeShape,
        };
      } else if (draft.kind !== hintKind) {
        // The DECLARED kind stands and the row is flagged. This branch used to
        // keep the sign-inferred direction and demote it, which inverted the
        // file's own statement of intent: `Typ=Kauf` with quantity 10, price
        // 220,50 and an UNSIGNED `Betrag` of 2205 resolved to `sell` — the exact
        // shape of `george.csv`, a type column plus no memo, and the exact
        // inverse of what the column says. It also contradicted this module's
        // own documented precedence ("the TEXT wins the default kind … while a
        // DECLARED kindHint outranks both"): the amount SIGN is the weakest link
        // in the chain, so it may cast doubt on a declaration, never overturn
        // one.
        draft = {
          kind: hintKind,
          confidence: 0.7,
          stage: 'structure',
          evidence:
            `${draft.evidence}; conflicts with kindHint "${hintLabel}" — ` +
            'the declared kind stands, the sign is the weaker signal',
          needsReview: true,
          hintConsumed: true,
          decisive: true,
          declared: true,
          tradeShape: draft.tradeShape,
        };
      } else {
        draft = { ...draft, hintConsumed: true, declared: true };
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
      evidence: `kindHint "${hintLabel}"`,
      needsReview: hintKind === 'fee' || hintKind === 'tax',
      hintConsumed: true,
      decisive: true,
      declared: true,
    };
  }

  // 4. Declared cash family: the amount sign IS the decision.
  if (cashFamilyHint) {
    return sign !== null
      ? {
          kind: sign === 1 ? 'deposit' : 'withdrawal',
          confidence: 0.88,
          stage: 'structure',
          evidence: `cash kindHint "${hintLabel}" + amount ${sign === 1 ? 'in' : 'out'}flow`,
          needsReview: false,
          hintConsumed: true,
          decisive: true,
        }
      : {
          kind: 'unknown',
          confidence: 0.5,
          stage: 'structure',
          evidence: `cash kindHint "${hintLabel}" without an amount sign`,
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

/** The signed direction the row's amount asserts, or null when it asserts none. */
function amountSign(row: ClassifiableRow): 1 | -1 | null {
  const amount = num(row.amount);
  return amount !== null && amount !== 0 ? (amount > 0 ? 1 : -1) : null;
}

function contradictsAmountSign(row: ClassifiableRow, kind: ClassifiedKind): boolean {
  const expected = KEYWORD_EXPECTED_SIGN[kind];
  const actual = amountSign(row);
  return expected !== undefined && actual !== null && actual !== expected;
}

/**
 * A non-trade marker fired. Nothing here can be booked: the row is pinned below
 * the review bar, flagged, blocked from a trade label, and kept away from stage
 * 3 entirely. The kind is the loudest CORRECT default available — `fee`/`tax`
 * when the table names one (a Vorabpauschale really is a tax charge), otherwise
 * `unknown`. A reversal voids even that.
 */
function markerVerdict(marker: MarkerHit, prose: Haystack): RowVerdict {
  const tableHit = marker.group.voidsKind ? null : matchKeywords(prose);
  const keepable =
    tableHit !== null && !WIRE_KINDS.includes(tableHit.kind) ? tableHit.kind : 'unknown';
  return {
    kind: keepable,
    confidence: marker.group.voidsKind ? REVERSAL_CONFIDENCE : MARKER_CONFIDENCE,
    stage: 'keyword',
    evidence:
      `non-trade marker "${marker.matched}" (${marker.group.id}) — ` +
      'this row is none of buy/sell/dividend/deposit/withdrawal; a human must decide',
    needsReview: true,
    tradeBlocked: true,
    aiEligible: false,
  };
}

/**
 * A decisive stage-1 reading, checked against the row's own text. Agreement
 * keeps stage 1's verdict; silence leaves it standing (there is nothing to
 * contradict it); disagreement drops the row below the bar.
 *
 * Which reading survives a disagreement is the whole point: a DECLARED hint
 * outranks prose, but a direction INFERRED from an amount sign does not. The
 * sign is the least reliable link in the chain — an unsigned `Betrag` column
 * inverts every trade in a file — so `Dividendengutschrift …` keeps `dividend`
 * and `Vorabpauschale …` keeps `tax`, instead of a fabricated sale.
 */
function corroborate(row: ClassifiableRow, draft: StageDraft, prose: Haystack): RowVerdict {
  const base: RowVerdict = {
    kind: draft.kind,
    confidence: draft.confidence,
    stage: draft.stage,
    evidence: draft.evidence,
    needsReview: draft.needsReview,
    tradeBlocked: false,
    aiEligible: true,
  };

  // A declared or inferred direction the row's own amount contradicts is the
  // same defect stage 2 checks for; stage 1 must not be exempt from it.
  if (contradictsAmountSign(row, draft.kind)) {
    return {
      ...base,
      confidence: Math.min(base.confidence, CONFLICTED_CONFIDENCE),
      evidence: `${draft.evidence} (contradicts the amount sign)`,
      needsReview: true,
    };
  }

  const hit = matchKeywords(prose);
  if (hit === null || hit.kind === draft.kind) {
    return hit === null
      ? base
      : { ...base, evidence: `${draft.evidence}; text agrees ("${hit.matched}")` };
  }

  // Disagreement. Keep the DECLARED kind, replace an INFERRED one.
  const keepDeclared = draft.declared === true;
  // …and keep a structural TRADE, because a fee or a tax named in the memo of a
  // row that states a share count AND a price is a LINE ITEM of that trade, not
  // what the row is. Cost markers outrank direction verbs in the table on
  // purpose, but that ranking is meant for rows whose only signal is prose —
  // applied to a decisive stage-1 trade it destroyed the standard German broker
  // line: `Wertpapierkauf Allianz SE, Provision EUR 5,90`, quantity 10, price
  // 220,50, amount −2210,90, with an ISIN, went from `buy/0.95` to `fee/0.6`,
  // and because that also set `tradeBlocked` no later stage could put the trade
  // back. The purchase disappeared and a 2 210,90 fee took its place.
  //
  // The doubt is real, though — a fee row and a trade row are not always
  // distinguishable from here — so the kind survives and the CONFIDENCE pays:
  // sub-threshold, flagged, with the cost word named for the reviewer.
  const costWordOnTrade =
    draft.tradeShape === true && (hit.kind === 'fee' || hit.kind === 'tax') && !keepDeclared;
  const keepDraftKind = keepDeclared || costWordOnTrade;
  const why = costWordOnTrade
    ? `a ${hit.kind} named on a quantity+price trade row is a line item of that trade, not its kind`
    : keepDeclared
      ? 'the declared kind stands'
      : 'the text wins the default';
  return {
    kind: keepDraftKind ? draft.kind : hit.kind,
    confidence: CONFLICTED_CONFIDENCE,
    stage: keepDraftKind ? draft.stage : 'keyword',
    evidence: `${draft.evidence}; text says ${hit.kind} ("${hit.matched}") — readings disagree, ${why}`,
    needsReview: true,
    tradeBlocked: !keepDraftKind && !KEYWORD_TRADE_KINDS.includes(hit.kind),
    aiEligible: true,
  };
}

/** Stage 2 — the keyword table resolves a row stage 1 left provisional. */
function applyKeyword(row: ClassifiableRow, draft: StageDraft, prose: Haystack): RowVerdict {
  const base: RowVerdict = {
    kind: draft.kind,
    confidence: draft.confidence,
    stage: 'keyword',
    evidence: draft.evidence,
    needsReview: true,
    tradeBlocked: false,
    aiEligible: true,
  };
  // No hit (or nothing to scan): mark the row attempted-at-keyword; it lands in
  // the stage-3 pool unless a later stage resolves it.
  if (prose.folded === '') return base;

  const hit = matchKeywords(prose);
  if (!hit) return base;

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
  const cashFallback = unbackedTrade ? matchKeywords(prose, KEYWORD_CASH_KINDS) : null;
  const kind = cashFallback?.kind ?? hit.kind;
  const matched = cashFallback?.matched ?? hit.matched;

  // Both checks read the RESOLVED kind: a substituted cash kind has to face the
  // same sign scrutiny the table's own cash hits do.
  const signContradicts = contradictsAmountSign(row, kind);
  // Cash movements essentially never carry an instrument identity — a keyword
  // that says "cash" on a row naming an asset is suspicious enough to show a
  // human (guards e.g. bond or ETF names containing "credit").
  const cashKindWithAsset =
    (kind === 'deposit' || kind === 'withdrawal') && hasInstrumentIdentity(row);

  const notes: string[] = [];
  if (signContradicts) notes.push('contradicts the amount sign');
  if (cashKindWithAsset) notes.push('cash kind on a row carrying an asset identity');
  if (unbackedTrade) {
    const gate = 'no instrument evidence — no quantity, symbol or ISIN names what was traded';
    notes.push(cashFallback !== null ? `trade keyword "${hit.matched}" ignored: ${gate}` : gate);
  }
  const internalOnly = kind === 'fee' || kind === 'tax';
  const doubtful = unbackedTrade || signContradicts;
  // Stage 2 REPLACES a weaker structural reading — but a reviewer needs to see
  // the reading it replaced, above all the `conflicts with kindHint` note stage
  // 1 raised on an unsigned-amount file. Dropping it left the queue showing a
  // verdict with no trace of the signal that disagreed with it.
  const superseded =
    draft.stage === 'structure' && draft.kind !== 'unknown' && draft.kind !== kind
      ? `; supersedes structure: ${draft.evidence}`
      : '';

  return {
    kind,
    confidence: doubtful ? UNBACKED_TRADE_CONFIDENCE : 0.85,
    stage: 'keyword',
    evidence: `keyword "${matched}" ⇒ ${kind}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}${superseded}`,
    // Sub-threshold already forces review at the end of the cascade; stating it
    // here too keeps the invariant unconditional under a lowered review bar.
    needsReview: internalOnly || signContradicts || cashKindWithAsset || unbackedTrade,
    tradeBlocked: unbackedTrade,
    aiEligible: true,
  };
}

/** The deterministic half of the cascade for one row: markers, stage 1, stage 2. */
function classifyDeterministically(row: ClassifiableRow): RowVerdict {
  const hint = joinHaystack([nonBlank(row.kindHint)]);
  const text = nonBlank(row.text);

  // Markers scan hint AND text unconditionally: a `Storno` in either column
  // voids the row, and no consumed-hint bookkeeping may hide it.
  const marker = matchNonTradeMarker(joinHaystack([nonBlank(row.kindHint), text]));

  const draft = classifyByStructure(row, hint);
  // A hint stage 1 consumed structurally is NOT re-mined as prose — see
  // {@link StageDraft.hintConsumed}. Non-canonical hint values still join the
  // haystack, exactly as the input contract promises.
  const prose = joinHaystack([draft.hintConsumed === true ? null : nonBlank(row.kindHint), text]);

  if (marker !== null) return markerVerdict(marker, prose);
  return draft.decisive === true ? corroborate(row, draft, prose) : applyKeyword(row, draft, prose);
}

// --- Stage 3 -----------------------------------------------------------------

/** The model alone — deliberately BELOW the review bar it is measured against. */
const AI_CONFIDENCE = 0.75;
/** The model AND an independent deterministic stage reached the same kind. */
const AI_CORROBORATED_CONFIDENCE = 0.85;
const UNRESOLVED_CONFIDENCE = 0.25;

/**
 * The evidence a row carries when the CALL, rather than the reply, is what
 * failed. Kept apart from the malformed-reply note below because they are not
 * the same fact: a spent budget comes back tomorrow, an unconfigured assistant
 * is nothing to wait for, an unreachable one is worth retrying — and none of
 * the three is the model answering badly about this row (#1857).
 */
const AI_FAILURE_EVIDENCE: Record<ImportAiFailure, string> = {
  'cap-exhausted': 'ai skipped — daily ai budget spent',
  unavailable: 'ai skipped — no assistant configured',
  failed: 'ai skipped — the assistant did not answer',
};

/** A batch's outcome: the labels it resolved, and why it resolved none. */
interface BatchOutcome {
  labels: Map<number, RowClassificationAiLabel | null>;
  /** Null ⇒ the call itself succeeded; the labels are what the model said. */
  failure: ImportAiFailure | null;
}

/**
 * One defensive batch call. Rows arrive with their POOL-GLOBAL index — the
 * prompt numbers rows by their position in the file (continuing across
 * chunks), so a reply stays attributable to the right row and the defensive
 * parser can reject out-of-batch hallucinations.
 */
async function classifyBatchWithAi(
  seam: ImportAiSeam,
  batch: readonly { index: number; row: ClassifiableRow }[],
): Promise<BatchOutcome> {
  const batchRows: AiBatchRow[] = batch.map(({ index, row }) => ({
    index,
    // Capped here as well as in the haystack: the prompt builder trims to 120
    // characters, but it should never be handed a megabyte to trim.
    text: capText(nonBlank(row.text)),
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
  } catch (err) {
    // The CALL failed — a spent daily budget, no configured assistant, or one
    // that did not answer. Every row of the batch stays unresolved and the
    // reason travels with the outcome, so the review row says which of the
    // three happened instead of blaming the model's reply. We never retry here;
    // the real seam refunds the daily cap itself.
    for (const batchRow of batchRows) labels.set(batchRow.index, null);
    return { labels, failure: importAiFailureOf(err) };
  }
  return { labels, failure: null };
}

/**
 * Sanitize a caller-supplied budget. `Math.max` PROPAGATES NaN, which made the
 * old sanitizer decorative and was not theoretical: `aiMaxRowsPerCall: NaN`
 * produced `slice(cursor, cursor + NaN)` ⇒ an empty batch ⇒ a cursor that never
 * advanced ⇒ an infinite SYNCHRONOUS loop that wedged the whole Node event loop
 * (vitest's own timeout could not fire). `aiMaxCalls: NaN` made `used >= NaN`
 * permanently false and disabled the budget outright.
 */
function budget(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const truncated = Math.trunc(value);
  return truncated < min ? min : truncated;
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
  // A non-finite bar would make EVERY `confidence < threshold` comparison false
  // and silently switch the review gate off for the whole file — the same NaN
  // class of defect as the AI budgets below, with a far larger blast radius.
  const threshold =
    ctx.reviewConfidenceBelow !== undefined && Number.isFinite(ctx.reviewConfidenceBelow)
      ? Math.min(1, Math.max(0, ctx.reviewConfidenceBelow))
      : DEFAULT_REVIEW_CONFIDENCE;
  const rowsPerCall = budget(ctx.aiMaxRowsPerCall, DEFAULT_AI_MAX_ROWS_PER_CALL, 1);
  const maxCalls = budget(ctx.aiMaxCalls, DEFAULT_AI_MAX_CALLS, 0);

  const verdicts: RowVerdict[] = [];
  const pool: { index: number; row: ClassifiableRow }[] = [];
  // Held OUTSIDE the verdicts, deliberately: stage 3 REPLACES a verdict object
  // wholesale, so a field on `RowVerdict` would have to be re-copied by every
  // future writer to survive. The sniffer's doubt is applied once, at the end,
  // where nothing can drop it.
  const sniffNotes: (string | null)[] = [];

  for (const [index, row] of rows.entries()) {
    const verdict = classifyDeterministically(row);
    verdicts.push(verdict);
    sniffNotes.push(sniffFlagNote(row));
    const resolved = verdict.kind !== 'unknown' && verdict.confidence >= threshold;
    if (!resolved && verdict.aiEligible) pool.push({ index, row });
  }

  // Stage 3: batched model fallback for the ambiguous remainder ONLY —
  // spending a model call on a row stages 1–2 settled would be a bug.
  if (ctx.ai !== undefined && pool.length > 0) {
    let callsUsed = 0;
    // Once the seam has said the caller's shared daily budget is spent, every
    // further call in this import is a guaranteed refusal. The budgeted
    // remainder is not spent on one — the rows are flagged with that reason
    // directly (#1857).
    let capExhausted = false;
    // `cursor` advances by the validated step UNCONDITIONALLY. The old loop
    // advanced by `batch.length`, so any input that produced an empty batch
    // spun forever; nothing a caller passes can wedge this one.
    for (let cursor = 0; cursor < pool.length; cursor += rowsPerCall) {
      const batch = pool.slice(cursor, cursor + rowsPerCall);
      if (batch.length === 0) continue;

      if (capExhausted || callsUsed >= maxCalls) {
        // No call is made for this batch: either the per-import call budget is
        // spent, or the user's daily AI budget is — flag the remainder for
        // review, with the reason, rather than looping.
        const note = capExhausted
          ? AI_FAILURE_EVIDENCE['cap-exhausted']
          : 'ai call budget exhausted';
        for (const { index } of batch) {
          const flagged = verdicts[index];
          if (flagged === undefined) continue;
          flagged.needsReview = true;
          if (capExhausted)
            flagged.confidence = Math.min(flagged.confidence, UNRESOLVED_CONFIDENCE);
          flagged.evidence += `; ${note}`;
        }
        continue;
      }
      callsUsed += 1;

      const { labels, failure } = await classifyBatchWithAi(ctx.ai, batch);
      if (failure !== null) {
        if (failure === 'cap-exhausted') capExhausted = true;
        for (const { index } of batch) {
          const flagged = verdicts[index];
          if (flagged === undefined) continue;
          flagged.needsReview = true;
          flagged.confidence = Math.min(flagged.confidence, UNRESOLVED_CONFIDENCE);
          flagged.evidence += `; ${AI_FAILURE_EVIDENCE[failure]}`;
        }
        continue;
      }

      for (const sent of batch) {
        const prior = verdicts[sent.index];
        if (prior === undefined) continue;
        const label = labels.get(sent.index) ?? null;

        if (label === null) {
          // Malformed or missing line: needs-review, NEVER a guessed kind.
          prior.needsReview = true;
          prior.confidence = Math.min(prior.confidence, UNRESOLVED_CONFIDENCE);
          prior.evidence += '; ai reply missing/malformed for this row';
          continue;
        }

        // A deterministic stage proved no instrument is named. The model may
        // not overturn that: it sees the same fields and cannot conjure the
        // ISIN the row does not carry, and booking a phantom trade is the
        // costliest wrong answer in the file.
        if (prior.tradeBlocked && KEYWORD_TRADE_KINDS.includes(label)) {
          prior.needsReview = true;
          prior.evidence += `; ai proposed ${label} — refused, the row names no instrument`;
          continue;
        }

        // An independent deterministic stage reaching the same kind is real
        // corroboration, so it RANKS the row higher in the review queue — it
        // does not release it (see `needsReview` below).
        const agreed = prior.kind !== 'unknown' && prior.kind === label;
        verdicts[sent.index] = {
          kind: label,
          confidence: agreed ? AI_CORROBORATED_CONFIDENCE : AI_CONFIDENCE,
          stage: 'ai',
          // The prior reading is EVIDENCE, not a draft to be discarded: it is
          // what a reviewer needs to judge the model's answer against.
          evidence: `${prior.evidence}; ai ⇒ ${label}`,
          // UNCONDITIONAL, and deliberately not an expression a caller can
          // influence: `ctx.aiLowTrustResults` is a FLOOR that defaults true,
          // whatever stages 1–2 demanded is subsumed, and corroboration ranks
          // rather than releases. A model label is therefore never the reason a
          // row stops being reviewed — which is the whole point, because a
          // stage-3 verdict used to clear flags stages 1–2 had raised and made
          // switching the AI fallback on LESS safe than leaving it off.
          needsReview: true,
          tradeBlocked: prior.tradeBlocked,
          aiEligible: false,
        };
      }
    }
  }

  return verdicts.map((verdict, index) => {
    // The confidence bar applies to EVERY stage. Exempting stage 3 from it let
    // a nominal 0.75 model verdict — below the bar this module documents —
    // clear review flags that stages 1–2 had raised, which made turning the AI
    // fallback ON strictly less safe than leaving it off.
    //
    // A sniffer flag is the third, independent reason to stop, and it is not
    // negotiable by confidence either: the classifier can be entirely right
    // about WHAT the row says and still be reading a totals line.
    const sniffNote = sniffNotes[index] ?? null;
    const needsReview = verdict.needsReview || verdict.confidence < threshold || sniffNote !== null;
    return {
      index,
      kind: verdict.kind,
      confidence: Math.round(Math.min(1, Math.max(0, verdict.confidence)) * 100) / 100,
      stage: verdict.stage,
      evidence: sniffNote === null ? verdict.evidence : `${verdict.evidence}; ${sniffNote}`,
      needsReview,
    };
  });
}
