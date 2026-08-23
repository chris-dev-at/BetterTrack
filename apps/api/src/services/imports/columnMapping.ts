/**
 * Universal column mapping for the file-understanding importer (PROJECTPLAN.md
 * §16 2026-07-31). Given a sniffed table's headers plus a sample of its data
 * rows, decide what each column IS over the shared import vocabulary (`date`,
 * `symbol`, `isin`, `description`, `quantity`, `price`, `amount`, `fee`, `tax`,
 * `currency`, `kindHint`, `ignore`) — staying compatible with the row kinds of
 * `@bettertrack/contracts` (§13.4 V4-P8).
 *
 * Two evidence sources, combined:
 *  1. A curated multilingual alias dictionary — broker/bank header vocabulary is
 *     a finite, knowable set, and a lookup table beats guessing. It encodes the
 *     MEASURED TRAPS a small LLM got wrong: `Valuta` is a DATE (value date, not
 *     currency), `Nominale` is a QUANTITY (not description),
 *     `Wertpapierbezeichnung` is the security NAME (description), `WKN` folds
 *     into `isin`, …
 *  2. Value-shape evidence from the sampled cells — an unknown-header column
 *     whose cells all parse as dates IS a date column; all-ISIN ⇒ isin;
 *     mixed-sign decimals ⇒ amount.
 *
 * Ambiguity is represented, never resolved by coin-flip: when two columns claim
 * the same field within {@link CONTEST_EPSILON}, both are flagged
 * `needsReview` and each records its contender. Below the confidence floor a
 * header lands in `unmapped`. Pure functions, no I/O.
 */

import { parseDay } from './csv';
import { parseLocalizedDecimal, type NumberLocale } from './table';

// --- Vocabulary --------------------------------------------------------------

export const MAPPABLE_FIELDS = [
  'date',
  'symbol',
  'isin',
  'description',
  'quantity',
  'price',
  'amount',
  'fee',
  'tax',
  'currency',
  'kindHint',
  'ignore',
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/** One header's assignment: what the column is, how sure, and WHY (which evidence produced it). */
export interface ColumnMapping {
  header: string;
  field: MappableField;
  /** [0..1]. Below {@link CONFIDENCE_FLOOR} the header lands in `unmapped` instead. */
  confidence: number;
  /**
   * Which evidence produced the match — `alias de 'Nominale' …`,
   * `shape date 5/5 (no alias)`, or the combination when both agree.
   */
  reason: string;
  /** True when a same-field contender scores within {@link CONTEST_EPSILON} — never silently picked. */
  needsReview: boolean;
  /** Set when this column LOSES a same-field contest: the column that beat it. */
  alternativeOf?: { header: string; confidence: number };
  /** Set on a contested WINNER: the close runner-up. */
  alternative?: { header: string; confidence: number };
}

export interface FieldWinner {
  header: string;
  index: number;
  confidence: number;
  needsReview: boolean;
}

export interface ColumnMapResult {
  /** One entry per ASSIGNED header, in input order. */
  mappings: ColumnMapping[];
  /** Headers with no confident assignment — never a wrong confident guess. */
  unmapped: string[];
  /**
   * The winning column per field (highest confidence, leftmost on ties),
   * derived so consumers don't re-implement the contest rules.
   */
  fieldWinners: Partial<Record<MappableField, FieldWinner>>;
}

/**
 * Project one data row through a {@link ColumnMapResult}: the raw cell of each
 * field's winning column. Values stay RAW here — parse them with the table's
 * locale-aware helpers (`parseLocalizedDay` / `parseLocalizedDecimal`).
 */
export function extractRowFields(
  result: ColumnMapResult,
  cells: string[],
): Partial<Record<Exclude<MappableField, 'ignore'>, string>> {
  const out: Partial<Record<Exclude<MappableField, 'ignore'>, string>> = {};
  for (const [field, winner] of Object.entries(result.fieldWinners) as [
    Exclude<MappableField, 'ignore'>,
    FieldWinner,
  ][]) {
    out[field] = cells[winner.index] ?? '';
  }
  return out;
}

// --- Alias dictionary --------------------------------------------------------

interface AliasEntry {
  field: MappableField;
  /** Dictionary rank [0.8..0.97]; shape evidence corroborates on top. */
  confidence: number;
  lang: 'de' | 'en' | 'combo';
  /** Why-trap note surfaced in `reason` (e.g. Valuta ≠ currency). */
  note?: string;
}

/**
 * The curated dictionary. Ranks are ordered so that PRIMARY terms beat their
 * secondary variants cleanly (Buchungsdatum > Valuta, Partnername >
 * Verwendungszweck) — a same-field contest within CONTEST_EPSILON then only
 * happens where a human really should look.
 */
const ALIAS_SOURCE: readonly (readonly [alias: string, entry: AliasEntry])[] = [
  // Dates — Buchungstag/booking day is the primary booking date; Valuta/value/
  // settlement dates are SECONDARY (and NEVER currency — the measured trap).
  ['datum', { field: 'date', confidence: 0.95, lang: 'de' }],
  ['buchungsdatum', { field: 'date', confidence: 0.97, lang: 'de' }],
  ['buchtag', { field: 'date', confidence: 0.96, lang: 'de' }],
  ['valuta', { field: 'date', confidence: 0.86, lang: 'de', note: 'value date, not currency' }],
  ['valutadatum', { field: 'date', confidence: 0.87, lang: 'de', note: 'value date, not currency' }],
  ['value date', { field: 'date', confidence: 0.87, lang: 'en', note: 'not currency' }],
  ['settle date', { field: 'date', confidence: 0.87, lang: 'en' }],
  ['settlement date', { field: 'date', confidence: 0.87, lang: 'en' }],
  ['date', { field: 'date', confidence: 0.95, lang: 'en' }],
  ['date/time', { field: 'date', confidence: 0.94, lang: 'en' }],
  ['datetime', { field: 'date', confidence: 0.94, lang: 'en' }],
  ['started date', { field: 'date', confidence: 0.88, lang: 'en' }],
  // The completion/settlement day is when the money actually moved — preferred.
  ['completed date', { field: 'date', confidence: 0.9, lang: 'en' }],
  ['ausführungsdatum', { field: 'date', confidence: 0.93, lang: 'de' }],
  ['execution date', { field: 'date', confidence: 0.93, lang: 'en' }],
  ['executed at', { field: 'date', confidence: 0.93, lang: 'en' }],

  // Instrument identity — WKN folds into isin per the shared vocabulary.
  ['isin', { field: 'isin', confidence: 0.97, lang: 'combo' }],
  ['wkn', { field: 'isin', confidence: 0.85, lang: 'de', note: 'national security id → isin slot' }],
  ['wkn/isin', { field: 'isin', confidence: 0.92, lang: 'combo' }],
  ['symbol', { field: 'symbol', confidence: 0.95, lang: 'en' }],
  ['ticker', { field: 'symbol', confidence: 0.95, lang: 'en' }],
  ['ticker symbol', { field: 'symbol', confidence: 0.95, lang: 'en' }],
  ['kürzel', { field: 'symbol', confidence: 0.85, lang: 'de' }],

  // Descriptions — the security NAME (Wertpapierbezeichnung/Titel/Bezeichnung)
  // and the booking MEMO (Buchungstext/Verwendungszweck) share one field, so
  // ranks order name > memo for the wizard's primary pick.
  ['beschreibung', { field: 'description', confidence: 0.93, lang: 'de' }],
  ['description', { field: 'description', confidence: 0.93, lang: 'en' }],
  ['wertpapierbezeichnung', { field: 'description', confidence: 0.96, lang: 'de', note: 'security NAME, not symbol' }],
  ['bezeichnung', { field: 'description', confidence: 0.9, lang: 'de', note: 'security name' }],
  ['wertpapier', { field: 'description', confidence: 0.9, lang: 'de', note: 'security name' }],
  ['titel', { field: 'description', confidence: 0.88, lang: 'de', note: 'security name' }],
  ['security name', { field: 'description', confidence: 0.9, lang: 'en' }],
  ['security', { field: 'description', confidence: 0.85, lang: 'en' }],
  ['name', { field: 'description', confidence: 0.8, lang: 'en' }],
  ['buchungstext', { field: 'description', confidence: 0.92, lang: 'de' }],
  ['verwendungszweck', { field: 'description', confidence: 0.9, lang: 'de' }],
  ['payment reference', { field: 'description', confidence: 0.85, lang: 'en', note: 'purpose text' }],
  ['partnername', { field: 'description', confidence: 0.92, lang: 'de' }],
  ['payee', { field: 'description', confidence: 0.92, lang: 'en' }],
  ['empfänger', { field: 'description', confidence: 0.85, lang: 'de' }],
  ['auftraggeber', { field: 'description', confidence: 0.85, lang: 'de' }],
  ['memo', { field: 'description', confidence: 0.88, lang: 'en' }],
  ['note', { field: 'description', confidence: 0.84, lang: 'en' }],
  ['notiz', { field: 'description', confidence: 0.84, lang: 'de' }],

  // Quantities — Stück/Anzahl/Nominale all count shares (measured trap:
  // Nominale is NOT a description).
  ['stück', { field: 'quantity', confidence: 0.95, lang: 'de' }],
  ['anzahl', { field: 'quantity', confidence: 0.95, lang: 'de' }],
  ['nominale', { field: 'quantity', confidence: 0.95, lang: 'de', note: 'nominal quantity, not description' }],
  ['menge', { field: 'quantity', confidence: 0.92, lang: 'de' }],
  ['quantity', { field: 'quantity', confidence: 0.95, lang: 'en' }],
  ['qty', { field: 'quantity', confidence: 0.93, lang: 'en' }],
  ['shares', { field: 'quantity', confidence: 0.9, lang: 'en' }],
  ['units', { field: 'quantity', confidence: 0.88, lang: 'en' }],

  // Prices.
  ['kurs', { field: 'price', confidence: 0.95, lang: 'de' }],
  ['ausführungskurs', { field: 'price', confidence: 0.96, lang: 'de' }],
  ['price', { field: 'price', confidence: 0.94, lang: 'en' }],
  ['t. price', { field: 'price', confidence: 0.94, lang: 'en', note: 'trade price' }],
  ['trade price', { field: 'price', confidence: 0.94, lang: 'en' }],
  ['execution price', { field: 'price', confidence: 0.94, lang: 'en' }],

  // Amounts — the signed cash effect.
  ['betrag', { field: 'amount', confidence: 0.95, lang: 'de' }],
  ['endbetrag', { field: 'amount', confidence: 0.93, lang: 'de' }],
  ['amount', { field: 'amount', confidence: 0.95, lang: 'en' }],
  ['proceeds', { field: 'amount', confidence: 0.82, lang: 'en' }],

  // Fees.
  ['gebühr', { field: 'fee', confidence: 0.95, lang: 'de' }],
  ['gebühren', { field: 'fee', confidence: 0.95, lang: 'de' }],
  ['provision', { field: 'fee', confidence: 0.94, lang: 'de' }],
  ['entgelt', { field: 'fee', confidence: 0.93, lang: 'de' }],
  ['spesen', { field: 'fee', confidence: 0.94, lang: 'de' }],
  ['fee', { field: 'fee', confidence: 0.94, lang: 'en' }],
  ['fees', { field: 'fee', confidence: 0.94, lang: 'en' }],
  ['comm/fee', { field: 'fee', confidence: 0.93, lang: 'en' }],
  ['commission', { field: 'fee', confidence: 0.93, lang: 'en' }],

  // Taxes.
  ['kest', { field: 'tax', confidence: 0.95, lang: 'de' }],
  ['kapitalertragsteuer', { field: 'tax', confidence: 0.95, lang: 'de' }],
  ['quellensteuer', { field: 'tax', confidence: 0.95, lang: 'de' }],
  ['steuer', { field: 'tax', confidence: 0.9, lang: 'de' }],
  ['tax', { field: 'tax', confidence: 0.92, lang: 'en' }],
  ['withholding tax', { field: 'tax', confidence: 0.92, lang: 'en' }],

  // Currency — Währung is currency while Valuta is NOT (kept apart by exact keys).
  ['währung', { field: 'currency', confidence: 0.95, lang: 'de' }],
  ['currency', { field: 'currency', confidence: 0.95, lang: 'en' }],
  ['curr.', { field: 'currency', confidence: 0.9, lang: 'en' }],

  // Kind hints — the column naming buy/sell/dividend/deposit/withdrawal.
  ['auftragsart', { field: 'kindHint', confidence: 0.92, lang: 'de' }],
  ['buchungsart', { field: 'kindHint', confidence: 0.9, lang: 'de' }],
  ['typ', { field: 'kindHint', confidence: 0.9, lang: 'de' }],
  ['type', { field: 'kindHint', confidence: 0.82, lang: 'en' }],
  ['transaction type', { field: 'kindHint', confidence: 0.88, lang: 'en' }],
  ['action', { field: 'kindHint', confidence: 0.85, lang: 'en' }],
  ['side', { field: 'kindHint', confidence: 0.85, lang: 'en' }],
  ['activity', { field: 'kindHint', confidence: 0.8, lang: 'en' }],
  ['buchungsinformationen', { field: 'kindHint', confidence: 0.84, lang: 'de', note: 'booking text naming the kind' }],

  // Deliberate noise — mapped to `ignore` so it never lands in unmapped nor
  // contests a real field by shape accident.
  ['kontonummer', { field: 'ignore', confidence: 0.95, lang: 'de' }],
  ['konto', { field: 'ignore', confidence: 0.85, lang: 'de' }],
  ['iban', { field: 'ignore', confidence: 0.95, lang: 'combo' }],
  ['account number', { field: 'ignore', confidence: 0.95, lang: 'en' }],
  ['saldo', { field: 'ignore', confidence: 0.9, lang: 'de' }],
  ['kontostand', { field: 'ignore', confidence: 0.9, lang: 'de' }],
  ['balance', { field: 'ignore', confidence: 0.9, lang: 'en' }],
  ['status', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['state', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['wechselkurs', { field: 'ignore', confidence: 0.92, lang: 'de' }],
  ['exchange rate', { field: 'ignore', confidence: 0.92, lang: 'en' }],
  ['ta-nr.', { field: 'ignore', confidence: 0.9, lang: 'de' }],
  ['referenz', { field: 'ignore', confidence: 0.85, lang: 'de' }],
  ['foreign currency', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['amount foreign currency', { field: 'ignore', confidence: 0.88, lang: 'en', note: 'informational FX twin of the EUR amount' }],
  ['type foreign currency', { field: 'ignore', confidence: 0.9, lang: 'en' }],
  ['datadiscriminator', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['data discriminator', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['asset category', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['c. price', { field: 'ignore', confidence: 0.85, lang: 'en', note: 'closing price, informational' }],
  ['closing price', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['basis', { field: 'ignore', confidence: 0.85, lang: 'en' }],
  ['realized p/l', { field: 'ignore', confidence: 0.9, lang: 'en' }],
  ['mtm p/l', { field: 'ignore', confidence: 0.9, lang: 'en' }],
  ['code', { field: 'ignore', confidence: 0.8, lang: 'en' }],
];

// --- Header normalization + key building ------------------------------------

/** Lowercase, trim, parens → spaces (`Amount (EUR)` keeps its qualifier as `amount eur`). */
function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/^["']+|["']+$/g, '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ');
}

/** ä→a ö→o ü→u ß→ss (+ strip remaining diacritics). */
function foldUmlauts(s: string): string {
  return s.replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** ä→ae ö→oe ü→ue ß→ss — the ASCII-safe spelling German exports use. */
function expandUmlauts(s: string): string {
  return s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

/** Every key an alias/header must match: folded + expanded spellings. */
function keyVariants(normalized: string): string[] {
  // Both ASCII spellings a German header can arrive in: `Gebühr` folds to
  // `gebuhr` but ships as `Gebuehr`; `Währung` ships as `Waehrung`. Expanding
  // the ORIGINAL (before folding) is what produces the `…ue`/`…ae` forms.
  const folded = foldUmlauts(normalized);
  const expanded = expandUmlauts(normalized);
  const foldedExpanded = foldUmlauts(expanded);
  return [...new Set([folded, expanded, foldedExpanded])];
}

/** Punctuation-insensitive fallback key (`WKN / ISIN` → `wkn isin`). */
function looseKey(variant: string): string {
  return variant.replace(/[./-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildDictionary(): Map<string, AliasEntry> {
  const dict = new Map<string, AliasEntry>();
  const put = (key: string, entry: AliasEntry): void => {
    if (!dict.has(key)) dict.set(key, entry);
  };
  for (const [alias, entry] of ALIAS_SOURCE) {
    const normalized = normalizeHeader(alias);
    for (const variant of keyVariants(normalized)) {
      put(variant, entry);
      put(looseKey(variant), entry);
    }
  }
  return dict;
}

const ALIAS_DICTIONARY: Map<string, AliasEntry> = buildDictionary();

/** Exact-then-loose alias lookup for one header. */
function lookupAlias(header: string): { entry: AliasEntry; label: string } | null {
  const normalized = normalizeHeader(header);
  const exact = keyVariants(normalized);
  for (const key of exact) {
    const hit = ALIAS_DICTIONARY.get(key);
    if (hit) return { entry: hit, label: normalized };
  }
  for (const variant of exact) {
    const hit = ALIAS_DICTIONARY.get(looseKey(variant));
    if (hit) return { entry: hit, label: normalized };
  }
  return null;
}

// --- Value-shape evidence ----------------------------------------------------

interface ShapeEvidence {
  samples: number;
  dateFrac: number;
  isinFrac: number;
  decimalFrac: number;
  mixedSign: boolean;
  currencyFrac: number;
  kindWordFrac: number;
}

const KIND_WORDS = new Set([
  'kauf', 'verkauf', 'buy', 'sell', 'dividende', 'dividend', 'ertrag',
  'ertragsgutschrift', 'einzahlung', 'auszahlung', 'deposit', 'withdrawal',
  'sparplan', 'zinsen', 'interest', 'topup',
]);

// Structural membership check for currency-shaped cells; mirrors the ISO list
// in table.ts (re-declared to keep these modules dependency-symmetric).
const ISO_CURRENCY_SHAPE = new Set([
  'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'CNY', 'HKD', 'SGD', 'ZAR', 'MXN', 'BRL',
  'INR', 'KRW', 'THB', 'MYR', 'IDR', 'PHP', 'AED', 'ILS',
]);

function analyzeShape(cells: string[], numberLocale: NumberLocale): ShapeEvidence {
  let date = 0;
  let isin = 0;
  let decimal = 0;
  let positive = false;
  let negative = false;
  let currency = 0;
  let kindWord = 0;
  let samples = 0;
  for (const raw of cells) {
    const cell = raw.trim();
    if (cell === '') continue;
    samples += 1;
    if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(cell)) isin += 1;
    if (/^[A-Z]{3}$/.test(cell) && ISO_CURRENCY_SHAPE.has(cell)) currency += 1;
    const value = parseLocalizedDecimal(cell, numberLocale);
    if (value !== null) {
      decimal += 1;
      if (value > 0) positive = true;
      if (value < 0) negative = true;
    }
    if (parseDay(cell.replace(/[.,;]+$/, '').trim()) !== null) date += 1;
    if (cell.toLowerCase().split(/[\s_]+/).some((token) => KIND_WORDS.has(token))) kindWord += 1;
  }
  return {
    samples,
    dateFrac: samples === 0 ? 0 : date / samples,
    isinFrac: samples === 0 ? 0 : isin / samples,
    decimalFrac: samples === 0 ? 0 : decimal / samples,
    mixedSign: positive && negative,
    currencyFrac: samples === 0 ? 0 : currency / samples,
    kindWordFrac: samples === 0 ? 0 : kindWord / samples,
  };
}

/** Shape-only confidence per field; 0 when the shape does not speak for it. */
function shapeScores(
  shape: ShapeEvidence,
): Partial<Record<MappableField, { score: number; desc: string }>> {
  const out: Partial<Record<MappableField, { score: number; desc: string }>> = {};
  const pct = (frac: number): string => `${Math.round(frac * shape.samples)}/${shape.samples}`;
  if (shape.samples === 0) return out;
  if (shape.dateFrac >= 0.75) {
    out.date = { score: 0.55 + 0.17 * shape.dateFrac, desc: `date ${pct(shape.dateFrac)}` };
  }
  if (shape.isinFrac >= 0.75) {
    out.isin = { score: 0.6 + 0.22 * shape.isinFrac, desc: `isin ${pct(shape.isinFrac)}` };
  }
  if (shape.currencyFrac >= 0.75) {
    out.currency = {
      score: 0.5 + 0.16 * shape.currencyFrac,
      desc: `currency ${pct(shape.currencyFrac)}`,
    };
  }
  if (shape.decimalFrac >= 0.75) {
    if (shape.mixedSign) {
      out.amount = {
        score: 0.5 + 0.14 * shape.decimalFrac,
        desc: `mixed-sign decimals ${pct(shape.decimalFrac)}`,
      };
    } else {
      // All-positive decimals could be quantity OR price — deliberately below
      // the assignment floor, so shape alone never picks between them.
      const weak = 0.42 + 0.1 * shape.decimalFrac;
      out.quantity = { score: weak, desc: `positive decimals ${pct(shape.decimalFrac)}` };
      out.price = { score: weak, desc: `positive decimals ${pct(shape.decimalFrac)}` };
    }
  }
  if (shape.kindWordFrac >= 0.6) {
    out.kindHint = {
      score: 0.5 + 0.15 * shape.kindWordFrac,
      desc: `kind words ${pct(shape.kindWordFrac)}`,
    };
  }
  return out;
}

// --- Assignment --------------------------------------------------------------

/** Minimum combined confidence before a header is assigned at all. */
export const CONFIDENCE_FLOOR = 0.6;
/** Same-field claims closer than this are CONTESTED (needsReview), not silently ranked. */
export const CONTEST_EPSILON = 0.05;

/**
 * The column mapper needs the number locale to read decimal shapes off its
 * samples; it derives it from the SAME column's cells (German exports vote
 * comma-decimal, English ones dot-decimal), defaulting German on a tie —
 * BetterTrack's home market, and an ambiguous integer parses under neither.
 * Calendar dates never vote: their dots are separators, not decimals.
 */
function detectColumnNumberLocale(cells: string[]): NumberLocale {
  let de = 0;
  let en = 0;
  for (const cell of cells) {
    if (isCalendarDaySample(cell)) continue;
    if (/\d,\d{1,2}(?!\d)/.test(cell)) de += 1;
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cell)) en += 1;
    else if (/\d\.\d{1,2}(?!\d)/.test(cell)) en += 1;
    else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cell)) {
      if (/,/.test(cell)) de += 1;
      else {
        de += 0.5;
        en += 0.5;
      }
    }
  }
  return de >= en ? 'de' : 'en';
}

const ISO_DAY_SAMPLE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/;
const GERMAN_DAY_SAMPLE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[T\s].*)?$/;
const US_DAY_SAMPLE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s].*)?$/;

function isCalendarDaySample(cell: string): boolean {
  const trimmed = cell.trim().replace(/[.,;]+$/, '');
  return (
    ISO_DAY_SAMPLE.test(trimmed) || GERMAN_DAY_SAMPLE.test(trimmed) || US_DAY_SAMPLE.test(trimmed)
  );
}

interface ScoredHeader {
  index: number;
  header: string;
  field: MappableField;
  confidence: number;
  reason: string;
}

/**
 * Map every header to its field. Per header the best (field, score) pair wins;
 * per field the strongest column wins outright, and any same-field claim within
 * {@link CONTEST_EPSILON} flags BOTH columns needsReview — ambiguity is shown,
 * never resolved by coin-flip. Weaker same-field columns keep their mapping as
 * recorded alternatives (Valuta next to Buchungsdatum), which is honest signal,
 * not noise.
 */
export function mapColumns(headers: string[], sampleRows: string[][]): ColumnMapResult {
  const cappedRows = sampleRows.slice(0, 200);

  interface Claim {
    scored: ScoredHeader;
    needsReview: boolean;
    alternative?: { header: string; confidence: number };
    alternativeOf?: { header: string; confidence: number };
  }

  const scored: ScoredHeader[] = [];

  headers.forEach((header, index) => {
    const cells = cappedRows.map((row) => row[index] ?? '').filter((c) => c.trim() !== '');
    const alias = lookupAlias(header);
    const shape = shapeScores(analyzeShape(cells, detectColumnNumberLocale(cells)));

    const candidates: Array<{ field: MappableField; score: number; reason: string }> = [];
    for (const field of MAPPABLE_FIELDS) {
      const entry = alias?.entry;
      const dictScore = entry && entry.field === field ? entry.confidence : 0;
      const shapeHit = shape[field];
      const shapeScore = shapeHit?.score ?? 0;
      const label = header.trim();
      if (entry && entry.field === field) {
        const note = entry.note ? ` (${entry.note})` : '';
        if (shapeHit && shapeScore >= CONFIDENCE_FLOOR) {
          candidates.push({
            field,
            score: Math.min(0.99, Math.max(dictScore, shapeScore) + 0.02),
            reason: `alias ${entry.lang} '${label}'${note} + shape ${shapeHit.desc}`,
          });
        } else {
          candidates.push({
            field,
            score: dictScore,
            reason: `alias ${entry.lang} '${label}'${note}`,
          });
        }
      } else if (shapeHit && shapeScore >= CONFIDENCE_FLOOR) {
        candidates.push({
          field,
          score: shapeScore,
          reason: `shape ${shapeHit.desc} (no alias match)`,
        });
      }
    }

    if (candidates.length === 0) return;
    candidates.sort(
      (a, b) =>
        b.score - a.score || MAPPABLE_FIELDS.indexOf(a.field) - MAPPABLE_FIELDS.indexOf(b.field),
    );
    const best = candidates[0];
    if (!best || best.score < CONFIDENCE_FLOOR) return;
    scored.push({ index, header, field: best.field, confidence: best.score, reason: best.reason });
  });

  // Strongest columns first; leftmost wins exact ties (files usually lead with
  // the primary column).
  const order = [...scored].sort(
    (a, b) => b.confidence - a.confidence || a.index - b.index,
  );

  const winners = new Map<MappableField, Claim>();
  const claims = new Map<number, Claim>();

  for (const candidate of order) {
    if (candidate.field === 'ignore') {
      claims.set(candidate.index, { scored: candidate, needsReview: false });
      continue;
    }
    const incumbent = winners.get(candidate.field);
    if (!incumbent) {
      const claim: Claim = { scored: candidate, needsReview: false };
      winners.set(candidate.field, claim);
      claims.set(candidate.index, claim);
      continue;
    }
    const delta = incumbent.scored.confidence - candidate.confidence;
    if (delta <= CONTEST_EPSILON) {
      // A real tie-up (Buchungstext vs Wertpapierbezeichnung): surface both.
      incumbent.needsReview = true;
      incumbent.alternative = { header: candidate.header, confidence: candidate.confidence };
      claims.set(candidate.index, {
        scored: candidate,
        needsReview: true,
        alternativeOf: {
          header: incumbent.scored.header,
          confidence: incumbent.scored.confidence,
        },
      });
    } else {
      claims.set(candidate.index, {
        scored: candidate,
        needsReview: false,
        alternativeOf: {
          header: incumbent.scored.header,
          confidence: incumbent.scored.confidence,
        },
      });
    }
  }

  const mappings: ColumnMapping[] = scored.map(({ index }) => {
    const claim = claims.get(index);
    if (!claim) throw new Error(`unassigned claim for header index ${index}`);
    return {
      header: claim.scored.header,
      field: claim.scored.field,
      confidence: round(claim.scored.confidence),
      reason: claim.scored.reason,
      needsReview: claim.needsReview,
      ...(claim.alternative
        ? { alternative: { ...claim.alternative, confidence: round(claim.alternative.confidence) } }
        : {}),
      ...(claim.alternativeOf
        ? {
            alternativeOf: {
              ...claim.alternativeOf,
              confidence: round(claim.alternativeOf.confidence),
            },
          }
        : {}),
    };
  });

  const assignedIndexes = new Set(scored.map((s) => s.index));
  const unmapped = headers.filter((_header, i) => !assignedIndexes.has(i));

  const fieldWinners: ColumnMapResult['fieldWinners'] = {};
  for (const [field, claim] of winners) {
    fieldWinners[field] = {
      header: claim.scored.header,
      index: claim.scored.index,
      confidence: round(claim.scored.confidence),
      needsReview: claim.needsReview,
    };
  }

  return { mappings, unmapped, fieldWinners };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
