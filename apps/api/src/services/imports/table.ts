/**
 * Universal table sniffing for the file-understanding importer (PROJECTPLAN.md
 * §16 2026-07-31: "IMPORT IS A WIZARD THAT UNDERSTANDS A WHOLE FILE"). Given an
 * uploaded buffer, work out WHAT the file is tabularly — delimiter, encoding,
 * which physical line carries the header (broker exports ship preamble lines),
 * and which locales its numbers and dates use — without the user declaring a
 * format. CSV/TSV only here: XLSX plugs in as another {@link TableSniffer}
 * front-end without touching the column mapper.
 *
 * Pure functions over bytes, no I/O. The lower-level CSV mechanics
 * (`countUnquoted`, `splitCells`, `sniffDelimiter`-style precedence) and the
 * number/date parsing come from `./csv` and are reused, not reimplemented.
 */

import { countUnquoted, parseDay, parseDecimal, splitCells, stripDecimalDecoration } from './csv';

// --- Hard input caps ---------------------------------------------------------

/**
 * Longest cell the sniff will ANALYZE. No broker field is remotely this long,
 * and every analysis helper (date/decimal/ISIN/summary-word) short-circuits
 * above it so a hostile upload cannot buy unbounded work per cell. Cells over
 * the cap are still returned verbatim in {@link SniffedTable.rows} — dropping
 * data the user can see in their file is the mirror-image bug — but the file
 * carries an `oversized-cell` issue so nobody mistakes the skipped analysis for
 * a clean read.
 */
export const MAX_CELL_CHARS = 4096;

/** Longest physical line the sniff will analyze; same contract as the cell cap. */
export const MAX_LINE_CHARS = 64 * 1024;

/**
 * How many physical lines ONE quoted record may span before the quoting is
 * treated as broken. A legitimate multi-line broker description is a handful of
 * lines; a stray inch-mark (`27" Monitor`) would otherwise swallow the rest of
 * the file into a single record.
 */
const MAX_RECORD_LINES = 32;

/** Per-kind ceiling on row-level issues, so a wholly ragged file cannot emit thousands. */
const MAX_ROW_ISSUES = 25;

/**
 * Date notation a file's data rows use (sampled, never taken from the header).
 * `de` is the dotted day-first form (`15.01.2024`); the two SLASH forms are
 * mirror images of each other — `us` is month-first (`01/15/2024`), `eu-slash`
 * day-first (`15/01/2024`) — and telling them apart is only possible when a
 * sampled component exceeds 12. When it never does, the file is genuinely
 * ambiguous and {@link SniffedTable.dateLocaleAmbiguous} says so rather than
 * the sniff picking a hemisphere and booking three months off.
 */
export type DateLocale = 'iso' | 'de' | 'us' | 'eu-slash';

/** Decimal notation a file's data rows use. */
export type NumberLocale = 'de' | 'en';

/**
 * Something the sniff could NOT resolve silently. Every kind here is a
 * money-corruption path if a caller ignores it, so they are reported as data
 * instead of being swallowed: a file whose columns cannot be matched to labels
 * imports nothing, and a summary row booked as a transaction is a phantom.
 */
export type TableIssueKind =
  /** No row in the file looks like a header — the columns are unlabeled. */
  | 'no-header-row'
  /** A header-like row exists but its column count differs from the data rows'. */
  | 'header-width-mismatch'
  /** A DATA row whose column count differs from the header's — its cells are misaligned. */
  | 'row-width-mismatch'
  /** A row that totals the ones above it (`Summe;;450,00`) — NOT a booking. */
  | 'summary-row'
  /** Slash dates whose day/month order the data cannot settle (all parts ≤ 12). */
  | 'ambiguous-date-locale'
  /** Dates written with a two-digit year — the century is inferred, not read. */
  | 'two-digit-year'
  /** The file is not valid UTF-8; a legacy single-byte encoding was assumed. */
  | 'encoding-fallback'
  /** Quote characters do not pair up — cell boundaries may be wrong. */
  | 'unbalanced-quote'
  /** A cell or line far longer than any real field; it was not analyzed. */
  | 'oversized-cell';

export interface TableIssue {
  kind: TableIssueKind;
  /** Physical 1-based line the issue points at; -1 for a whole-file property. */
  line: number;
  /** Index into {@link SniffedTable.rows} when the issue points at one; -1 otherwise. */
  row: number;
  /** Operator-facing explanation — safe to surface in the import wizard. */
  message: string;
}

/**
 * One sniffed table: everything the column mapper and the row reader need.
 * `headerRowIndex` is the 1-based PHYSICAL line number of the header row
 * (matching the `CsvRecord.line` convention, so a preview row points at the
 * real line in the user's file); -1 when no header-like row exists.
 * `lineNumbers` runs parallel to `rows` for the same audit-trail reason.
 */
export interface SniffedTable {
  delimiter: string;
  encoding: 'utf-8' | 'utf-16le' | 'windows-1252';
  headerRowIndex: number;
  headers: string[];
  rows: string[][];
  /** Physical 1-based line number per entry of `rows` (parallel array). */
  lineNumbers: number[];
  dateLocale: DateLocale;
  /**
   * True when `dateLocale` is a GUESS between the two slash notations because
   * no sampled date had a component above 12. The reader must force review
   * instead of booking unattended — `01/02/2024` is either 1 Feb or 2 Jan.
   */
  dateLocaleAmbiguous: boolean;
  numberLocale: NumberLocale;
  /** Majority ISO currency seen in the data rows, `EUR` when none (the cash ledger is EUR-only, §14). */
  defaultCurrency: string;
  /** Everything the sniff could not resolve silently; empty on a clean file. */
  issues: TableIssue[];
}

/** Thrown when no sniff front-end can claim the buffer (e.g. an XLSX today). */
export class UnsupportedFileFormatError extends Error {
  constructor(filename: string, reason: string) {
    super(`Cannot import "${filename}": ${reason}`);
    this.name = 'UnsupportedFileFormatError';
  }
}

/**
 * Counts how many cells of a candidate header row are KNOWN import vocabulary.
 * Injected rather than imported: this module owns table mechanics and must not
 * depend on the column mapper that owns the alias dictionary (the dependency
 * runs mapper → table, and a cycle in a money path is not worth the
 * convenience). `columnMapping.countKnownHeaderAliases` is the implementation;
 * `columnMapping.understandTable` wires it in.
 */
export type HeaderVocabulary = (cells: string[]) => number;

export interface SniffOptions {
  /** Optional dictionary evidence for ranking header-row candidates. */
  headerVocabulary?: HeaderVocabulary;
}

/**
 * One sniff front-end. CSV is the only implementation in this task; an XLSX
 * front-end registers here later and `sniffTable` dispatches without the
 * mapper ever knowing the difference.
 */
export interface TableSniffer {
  readonly id: 'csv' | 'xlsx';
  canSniff(buffer: Uint8Array, filename: string): boolean;
  sniff(buffer: Uint8Array, filename: string, options: SniffOptions): SniffedTable | null;
}

// --- Encoding ----------------------------------------------------------------

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];

const REPLACEMENT_CHARACTER = '�';

interface DecodedText {
  text: string;
  encoding: SniffedTable['encoding'];
  /** True when UTF-8 did not decode and a legacy single-byte encoding was assumed. */
  assumedLegacy: boolean;
  /** True when the decoded text still carries U+FFFD — bytes were genuinely lost. */
  lostCharacters: boolean;
}

/**
 * Decode the buffer, stripping the BOM. UTF-16BE is refused (no broker ships
 * it).
 *
 * A BOM is a DECLARATION and is trusted. Without one, UTF-8 is tried in FATAL
 * mode: the previous non-fatal decode turned every non-UTF-8 byte into U+FFFD
 * and reported the file as clean `utf-8`, so an ISO-8859-1 export — routine for
 * German bank CSVs — arrived with headers `Geb?hr` and `St?ck`, which matched no
 * alias, landed in `unmapped`, and dropped the fee and quantity columns
 * entirely while `issues` stayed empty. On a fatal decode failure the buffer is
 * re-read as Windows-1252 (the practical superset of ISO-8859-1: identical for
 * the umlauts, and it fills in 0x80–0x9F), which recovers those headers exactly.
 *
 * That re-read is an INFERENCE — the byte 0xE4 is `ä` in Windows-1252 and
 * something else in Windows-1250 — so the caller always gets an
 * `encoding-fallback` issue with it. Correct parsing plus a loud flag beats
 * both silent mojibake and a blanket refusal.
 */
function decodeText(buffer: Uint8Array): DecodedText {
  const startsWith = (bom: number[]): boolean => bom.every((b, i) => buffer[i] === b);
  const finish = (
    text: string,
    encoding: SniffedTable['encoding'],
    assumedLegacy: boolean,
  ): DecodedText => ({
    text,
    encoding,
    assumedLegacy,
    lostCharacters: text.includes(REPLACEMENT_CHARACTER),
  });

  if (startsWith(UTF8_BOM)) {
    return finish(new TextDecoder('utf-8').decode(buffer), 'utf-8', false);
  }
  if (startsWith(UTF16LE_BOM)) {
    return finish(new TextDecoder('utf-16le').decode(buffer), 'utf-16le', false);
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new UnsupportedFileFormatError(
      '(buffer)',
      'UTF-16BE encoding is not supported — re-export as UTF-8.',
    );
  }
  try {
    return finish(new TextDecoder('utf-8', { fatal: true }).decode(buffer), 'utf-8', false);
  } catch {
    return finish(new TextDecoder('windows-1252').decode(buffer), 'windows-1252', true);
  }
}

/** The issue a decode owes the caller, or null when the bytes spoke for themselves. */
function encodingIssue(decoded: DecodedText): TableIssue | null {
  if (decoded.assumedLegacy) {
    return {
      kind: 'encoding-fallback',
      line: -1,
      row: -1,
      message:
        'This file is not valid UTF-8, so it was read as Windows-1252 (the usual encoding for ' +
        'German bank exports). Check that accented characters look right — if they do not, ' +
        're-export the file as UTF-8.',
    };
  }
  if (decoded.lostCharacters) {
    return {
      kind: 'encoding-fallback',
      line: -1,
      row: -1,
      message:
        `This file contains characters that could not be decoded (shown as ` +
        `"${REPLACEMENT_CHARACTER}"). Column labels and text carrying them may not be ` +
        'recognized — re-export the file as UTF-8.',
    };
  }
  return null;
}

// --- Header-row detection ----------------------------------------------------

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/**
 * A slash calendar day in EITHER order — the notation is recognizable, the
 * day/month ORDER is not (see {@link DateLocale}). Shared with the column
 * mapper so both modules agree on what counts as a date-shaped cell.
 */
export const SLASH_DAY_SAMPLE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s].*)?$/;

/** A cell that parses as a date (any supported notation), decimal, or ISIN — data, not a label. */
function isDataShaped(cell: string): boolean {
  if (cell === '') return false;
  // Nothing this long is a date, a decimal or an ISIN, and analyzing it is
  // exactly the work a hostile upload wants to buy.
  if (isOversizedCell(cell)) return false;
  const trimmed = trimTrailingPunctuation(cell);
  if (parseDay(trimmed) !== null) return true;
  // `15.01.24` is a date, not a label — see GERMAN_SHORT_DAY_SAMPLE.
  if (parseGermanShortDay(trimmed) !== null) return true;
  if (parseDecimal(cell) !== null) return true;
  if (parseEnglishDecimal(cell) !== null) return true;
  return ISIN_PATTERN.test(cell);
}

const CELL_PUNCTUATION = new Set(['.', ',', ';']);
const LABEL_PUNCTUATION = new Set(['.', ':', ';']);

/**
 * Drop a trailing run of `chars` by walking the string from its end.
 *
 * Deliberately NOT a regex. `/[.,;]+$/` is quadratic on `'.'.repeat(n) + 'x'`
 * (measured: 8k→102ms, 16k→373ms, 32k→1716ms, 64k→7038ms — 4× per doubling),
 * and this ran once per cell from five call sites, so one 4 MB upload pinned an
 * API worker for two minutes with `IMPORT_MAX_FILE_BYTES` at 5 MB, multer on
 * memoryStorage and parsing synchronous. An index walk is O(n) with no
 * backtracking to exploit. (`re2` would also be safe — the repo adopted it for
 * this class in b657d6a3 — but a native call per cell is far more expensive
 * than the four lines below.)
 */
function trimTrailingFrom(cell: string, chars: ReadonlySet<string>): string {
  let end = cell.length;
  while (end > 0 && chars.has(cell[end - 1]!)) end -= 1;
  return end === cell.length ? cell : cell.slice(0, end);
}

/**
 * `Date/Time` values arrive quoted with a trailing comma inside the cell
 * (`"2024-01-16, 09:32:11"`); the calendar day before the comma is what a date
 * check must see. Only trailing punctuation is dropped — a leading one would
 * change the number.
 */
export function trimTrailingPunctuation(cell: string): string {
  return trimTrailingFrom(cell, CELL_PUNCTUATION).trim();
}

/** A cell too long to be a real field — never analyzed, always reported. */
function isOversizedCell(cell: string): boolean {
  return cell.length > MAX_CELL_CHARS;
}

/**
 * A row whose cells look like LABELS: mostly non-empty, none parsing as a
 * date/decimal/ISIN, at least one carrying letters. Necessary but NOT
 * sufficient to be the header — a broker preamble line
 * (`Konto;Inhaber;Waehrung;Filiale;Typ`) satisfies all of it, which is why
 * {@link scoreHeaderCandidate} ranks the candidates instead of taking the first.
 */
function looksLikeHeader(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => c.trim() !== '');
  if (nonEmpty.length === 0) return false;
  if (cells.length >= 2 && nonEmpty.length < Math.max(2, Math.ceil(cells.length / 2))) {
    return false;
  }
  if (nonEmpty.some(isDataShaped)) return false;
  return nonEmpty.some((c) => /[a-zäöü]/i.test(c));
}

/** How many rows below a candidate are inspected for data-shapedness. */
const HEADER_LOOKAHEAD = 12;

/** A row carrying at least one date/decimal/ISIN cell — the shape of a booking. */
function isDataRow(cells: string[]): boolean {
  return cells.some((c) => c.trim() !== '' && isDataShaped(c));
}

/**
 * Rank one header candidate, or DISQUALIFY it (null).
 *
 * The measured failure this replaces: a file whose first line is an account
 * preamble (`Konto;Inhaber;Waehrung;Filiale;Typ`) at the same width as the real
 * header (`Buchtag;Valuta;Buchungstext;TA-Nr.;Betrag`) used to win purely by
 * being first, and the importer then read the booking-text column as
 * `currency ← Waehrung` at 0.95 confidence with no review flag while `amount`
 * vanished entirely. A label row directly above another label row is never the
 * header — that is the disqualification below.
 *
 * The remaining score answers "how well does this row HEAD a block of data":
 * the successor block runs to the next label row (so in a multi-section
 * statement each section header is judged on its own section, not on the
 * sections after it), and dictionary hits only break ties between rows that are
 * already structurally plausible.
 */
function scoreHeaderCandidate(
  below: string[][],
  cells: string[],
  vocabulary: HeaderVocabulary | undefined,
): number | null {
  // A label row whose immediate successor is another label row is a preamble.
  if (below.length > 0 && looksLikeHeader(below[0]!)) return null;

  const block: string[][] = [];
  for (const row of below.slice(0, HEADER_LOOKAHEAD)) {
    if (looksLikeHeader(row)) break; // the next section starts here
    block.push(row);
  }
  const successorScore = block.length === 0 ? 0 : block.filter(isDataRow).length / block.length;
  const vocabularyScore = vocabulary && cells.length > 0 ? vocabulary(cells) / cells.length : 0;
  // Structure outweighs vocabulary: shape evidence is always available, the
  // dictionary is optional and only ever a tie-breaker.
  return successorScore * 2 + vocabularyScore;
}

// --- Delimiter sniffing ------------------------------------------------------

const DELIMITERS = [';', ',', '\t'] as const;

/**
 * Pick the delimiter producing the widest CONSISTENT table across all lines —
 * not just the most frequent separator on one line, because preamble lines
 * ("Kontoumsätze;Zeitraum …") split differently than the real table. Score is
 * modal-cell-count × share-of-lines-at-that-count; ties resolve to the
 * csv.ts precedence (`;` > `,` > tab) via iteration order.
 */
function sniffTableDelimiter(lines: string[]): string {
  let best: string = DELIMITERS[0];
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const freq = new Map<number, number>();
    for (const line of lines) {
      const width = countUnquoted(line, d) + 1;
      freq.set(width, (freq.get(width) ?? 0) + 1);
    }
    let modal = 0;
    let modalFreq = 0;
    for (const [width, count] of freq) {
      if (count > modalFreq || (count === modalFreq && width > modal)) {
        modal = width;
        modalFreq = count;
      }
    }
    const score = modal * (modalFreq / lines.length);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

// --- Locale detection (data rows only, never the header) ---------------------

/** `2024-01-15` — shared with the column mapper (single definition, §M4). */
export const ISO_DAY_SAMPLE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/;
/** `15.01.2024` — shared with the column mapper. */
export const GERMAN_DAY_SAMPLE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[T\s].*)?$/;
/**
 * `15.01.24` — the two-digit-year German day. Recognizing it is not a nicety:
 * while it matched NO date sample, `detectNumberLocale` did not skip it, so
 * `/\d\.\d{1,2}(?!\d)/` saw `5.01` and voted ENGLISH once or twice per row. A
 * plain German file was then read as `en`, every `Stück` value `1,250` came
 * back as 1250 instead of 1.25 (1000× high) at 0.95 confidence with
 * `issues: []`, and every date and amount in it parsed to null — a total parse
 * failure presented as a green light.
 */
export const GERMAN_SHORT_DAY_SAMPLE = /^(\d{1,2})\.(\d{1,2})\.(\d{2})(?:[T\s].*)?$/;

/**
 * Two-digit year → full year. The century is NOT in the file, so this is an
 * inference, not a reading: 00–68 → 2000s, 69–99 → 1900s (the POSIX `%y`
 * pivot). Every file that needs it carries a `two-digit-year` issue, so the
 * guess is always visible rather than baked silently into a booking date.
 */
function expandTwoDigitYear(yy: string): number {
  const n = Number(yy);
  return n <= 68 ? 2000 + n : 1900 + n;
}

/** Parse `DD.MM.YY` at 12:00 UTC, or null when it is not that shape / not a real day. */
function parseGermanShortDay(input: string): Date | null {
  const match = GERMAN_SHORT_DAY_SAMPLE.exec(input.trim());
  if (!match) return null;
  const [, day, month, yy] = match as unknown as [string, string, string, string];
  return parseDay(`${expandTwoDigitYear(yy)}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

/** The date notation, whether the slash ORDER had to be guessed, and whether a century was. */
interface DateLocaleEvidence {
  locale: DateLocale;
  ambiguous: boolean;
  /** True when any sampled day used a two-digit year, so its century was inferred. */
  twoDigitYear: boolean;
}

/** Is `d/m/y` (in that order) a real calendar day? Used to weigh slash evidence. */
function isRealDay(year: string, month: string, day: string): boolean {
  return parseDay(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`) !== null;
}

/**
 * Detect the date notation by sampling data cells; `iso` on no evidence.
 *
 * Slash dates get their own arbitration because the two notations are mirror
 * images: `01/02/2024` is 1 February day-first and 2 January month-first, and
 * the file itself is the only witness. A sampled component ABOVE 12 can only be
 * a day, so it proves the order; when nothing in the file ever exceeds 12 the
 * order is unknowable and the caller is told (`ambiguous`) instead of the sniff
 * silently defaulting to one hemisphere and shifting bookings by months.
 */
function detectDateLocale(cells: string[]): DateLocaleEvidence {
  let iso = 0;
  let de = 0;
  let slash = 0;
  let dayFirstProof = 0;
  let monthFirstProof = 0;
  let twoDigitYear = 0;
  for (const raw of cells) {
    if (isOversizedCell(raw)) continue;
    const cell = trimTrailingPunctuation(raw);
    if (ISO_DAY_SAMPLE.test(cell) && parseDay(cell) !== null) {
      iso += 1;
      continue;
    }
    if (GERMAN_DAY_SAMPLE.test(cell) && parseDay(cell) !== null) {
      de += 1;
      continue;
    }
    // A dotted day-first date whose year is two digits. It votes German like
    // its four-digit sibling; the inferred century is reported separately.
    if (parseGermanShortDay(cell) !== null) {
      de += 1;
      twoDigitYear += 1;
      continue;
    }
    const match = SLASH_DAY_SAMPLE.exec(cell);
    if (!match) continue;
    slash += 1;
    const [, first, second, year] = match as unknown as [string, string, string, string];
    // A component above 12 is a day — but only counts as proof when reading it
    // that way yields a real calendar date (a broken cell must not flip a file).
    if (Number(first) > 12 && Number(second) <= 12 && isRealDay(year, second, first)) {
      dayFirstProof += 1;
    } else if (Number(second) > 12 && Number(first) <= 12 && isRealDay(year, first, second)) {
      monthFirstProof += 1;
    }
  }
  const short = twoDigitYear > 0;
  if (iso >= de && iso >= slash) return { locale: 'iso', ambiguous: false, twoDigitYear: false };
  if (de > slash) return { locale: 'de', ambiguous: false, twoDigitYear: short };
  if (monthFirstProof > 0 && dayFirstProof === 0)
    return { locale: 'us', ambiguous: false, twoDigitYear: false };
  if (dayFirstProof > 0 && monthFirstProof === 0)
    return { locale: 'eu-slash', ambiguous: false, twoDigitYear: false };
  // Either no component ever exceeded 12, or the file contradicts itself. Both
  // are unresolvable here; day-first is the reading of BetterTrack's home
  // market (§14) and the ambiguity flag keeps it out of unattended booking.
  return {
    locale: monthFirstProof > dayFirstProof ? 'us' : 'eu-slash',
    ambiguous: true,
    twoDigitYear: false,
  };
}

/**
 * Detect the decimal notation. Decimal commas and grouping dots vote German,
 * decimal dots and grouping commas vote English; an ambiguous grouping-dot
 * integer (`1.000`) counts HALF each — csv.ts refuses to parse it either way,
 * so it must not tip the locale. Calendar dates NEVER vote: a German date's
 * dots are separators, not decimals.
 */
export function isCalendarDaySample(cell: string): boolean {
  if (isOversizedCell(cell)) return false;
  const trimmed = trimTrailingPunctuation(cell);
  return (
    ISO_DAY_SAMPLE.test(trimmed) ||
    GERMAN_DAY_SAMPLE.test(trimmed) ||
    // Two-digit-year German days are dates too — this is the exclusion that
    // stops `15.01.24` from voting ENGLISH through its `5.01` substring.
    GERMAN_SHORT_DAY_SAMPLE.test(trimmed) ||
    SLASH_DAY_SAMPLE.test(trimmed)
  );
}

/** A decimal comma with 1–2 following digits (`-751,00`) — only German writes this. */
const DECIMAL_COMMA = /\d,\d{1,2}(?!\d)/;
/** A decimal dot with 1–2 following digits (`-751.00`) — only English writes this. */
const DECIMAL_DOT = /\d\.\d{1,2}(?!\d)/;
/** Comma-grouped, optionally with a dot decimal: `1,234`, `1,234,567`, `1,234.56`. */
const COMMA_GROUPED = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
/** Dot-grouped, optionally with a comma decimal: `1.234`, `1.234.567`, `1.234,56`. */
const DOT_GROUPED = /^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/;
/**
 * `1,250` — ONE comma group, no decimal point. English reads 1250, German reads
 * 1.25, and the cell alone cannot say which. The exact mirror of `1.000`, which
 * this module has always counted as half a vote each way, so this one does too:
 * letting it vote ENGLISH outright is how a German file with 3-decimal `Stück`
 * values flipped locale and inflated every quantity 1000×.
 */
const AMBIGUOUS_COMMA_GROUP = /^[+-]?\d{1,3},\d{3}$/;
/** `1.000` — the German-side mirror of {@link AMBIGUOUS_COMMA_GROUP}. */
const AMBIGUOUS_DOT_GROUP = /^[+-]?\d{1,3}\.\d{3}$/;

/**
 * Tally the German/English evidence over a set of cells. Decimal commas and
 * grouping dots vote German, decimal dots and grouping commas vote English; the
 * two mirror-ambiguous integer forms (`1.000` / `1,250`) count HALF each,
 * because neither notation's parser will accept them and a full vote from a
 * cell nobody can read is how a file flips locale. Calendar dates NEVER vote: a
 * German date's dots are separators, not decimals.
 *
 * Exported as the SINGLE definition (§M4) — the column mapper's per-column
 * fallback used to carry a near-verbatim copy, so a fix here silently missed
 * there. Only the tie rule differs between the two callers, so only that stays
 * with them.
 */
export function tallyNumberLocale(cells: string[]): { de: number; en: number } {
  let de = 0;
  let en = 0;
  for (const raw of cells) {
    if (isOversizedCell(raw)) continue;
    if (isCalendarDaySample(raw)) continue;
    const cell = trimTrailingPunctuation(raw);
    if (DECIMAL_COMMA.test(cell)) de += 1;
    else if (COMMA_GROUPED.test(cell)) {
      if (AMBIGUOUS_COMMA_GROUP.test(cell)) {
        de += 0.5;
        en += 0.5;
      } else en += 1;
    } else if (DECIMAL_DOT.test(cell)) en += 1;
    else if (DOT_GROUPED.test(cell)) {
      if (AMBIGUOUS_DOT_GROUP.test(cell)) {
        de += 0.5;
        en += 0.5;
      } else de += 1;
    }
  }
  return { de, en };
}

function detectNumberLocale(cells: string[], dateLocale: DateLocale): NumberLocale {
  const { de, en } = tallyNumberLocale(cells);
  if (de > en) return 'de';
  if (en > de) return 'en';
  return dateLocale === 'de' ? 'de' : 'en';
}

/**
 * Common ISO-4217 codes a broker/bank export carries (structural + membership,
 * not the full list). Exported as the SINGLE definition — the column mapper
 * imports it rather than keeping a copy that can drift (§M4).
 */
export const ISO_CURRENCIES = new Set([
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'JPY',
  'AUD',
  'CAD',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'TRY',
  'CNY',
  'HKD',
  'SGD',
  'ZAR',
  'MXN',
  'BRL',
  'INR',
  'KRW',
  'THB',
  'MYR',
  'IDR',
  'PHP',
  'AED',
  'ILS',
]);

/** Majority standalone ISO code among data cells; `EUR` when none (§14 cash ledger). */
function detectDefaultCurrency(cells: string[]): string {
  const freq = new Map<string, number>();
  for (const cell of cells) {
    if (/^[A-Z]{3}$/.test(cell) && ISO_CURRENCIES.has(cell)) {
      freq.set(cell, (freq.get(cell) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [code, count] of freq) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best ?? 'EUR';
}

// --- Summary rows ------------------------------------------------------------

/**
 * Words a TOTALS row leads with. Deliberately short: every entry has to be a
 * word no real counterparty/booking text starts with while ALSO carrying no
 * date, or the detector starts flagging genuine bookings.
 */
const SUMMARY_WORDS = new Set([
  'summe',
  'zwischensumme',
  'gesamtsumme',
  'gesamt',
  'insgesamt',
  'saldo',
  'endsaldo',
  'schlusssaldo',
  'übertrag',
  'uebertrag',
  'total',
  'totals',
  'subtotal',
  'sum',
]);

function rowHasDay(cells: string[]): boolean {
  return cells.some((c) => {
    if (isOversizedCell(c)) return false;
    const trimmed = trimTrailingPunctuation(c);
    return parseDay(trimmed) !== null || parseGermanShortDay(trimmed) !== null;
  });
}

function rowHasDecimal(cells: string[]): boolean {
  return cells.some(
    (c) => !isOversizedCell(c) && (parseDecimal(c) !== null || parseEnglishDecimal(c) !== null),
  );
}

/**
 * The summary word a row carries, or null.
 *
 * `exactOnly` demands the word be the WHOLE cell. A dated row gets that strict
 * reading because it has lost the corroborating evidence of being undated: the
 * looser first-token rule would then flag `03.01.2024;Summe Sport GmbH;-20,00`
 * — a genuine booking to a company whose name starts with a summary word.
 * Undated rows keep the loose rule they always had.
 */
function summaryWordOf(cells: string[], exactOnly: boolean): string | null {
  for (const cell of cells) {
    if (isOversizedCell(cell)) continue;
    const normalized = trimTrailingFrom(cell.trim().toLowerCase(), LABEL_PUNCTUATION);
    if (normalized === '') continue;
    if (SUMMARY_WORDS.has(normalized)) return normalized;
    if (exactOnly) continue;
    const first = normalized.split(/[\s_]+/)[0] ?? '';
    if (SUMMARY_WORDS.has(first)) return first;
  }
  return null;
}

/**
 * Flag rows that TOTAL the ones around them (`Summe;;450,00`, IBKR's
 * `Total,,,2100`). Booked as transactions they are phantom money — the sum
 * lands in the ledger a second time — so they are reported, never silently
 * kept as ordinary data.
 *
 * A row needs a summary word and a number to total. It does NOT need to be
 * undated: the common German form carries the period-end date
 * (`31.01.2024;Endsaldo;3.000,00`), and bailing on every dated row let exactly
 * the double-count this function exists to prevent through — with `issues: []`.
 * Datelessness is treated as what it is, corroborating evidence rather than a
 * precondition: an UNDATED row may match a summary word loosely (and only when
 * the file dates its other rows at all, otherwise datelessness says nothing),
 * while a DATED row must match one exactly.
 *
 * Rows are FLAGGED, not dropped: silently discarding a row the user can see in
 * their file is the mirror-image bug.
 */
function detectSummaryRows(rows: string[][], lineNumbers: number[]): TableIssue[] {
  if (rows.length < 2) return [];
  const fileDatesItsRows = rows.some(rowHasDay);
  const issues: TableIssue[] = [];
  rows.forEach((cells, index) => {
    if (!rowHasDecimal(cells)) return;
    const dated = rowHasDay(cells);
    if (!dated && !fileDatesItsRows) return;
    const word = summaryWordOf(cells, dated);
    if (word === null) return;
    issues.push({
      kind: 'summary-row',
      line: lineNumbers[index] ?? -1,
      row: index,
      message:
        `Line ${lineNumbers[index] ?? '?'} reads as a "${word}" total of the rows around it ` +
        `instead of booking a transaction — importing it would double-count that amount.`,
    });
  });
  return issues;
}

/** Non-empty cells of the data rows, capped — sampling, not a full scan contract. */
function sampleCells(rows: string[][], maxCells = 4000): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const cell of row) {
      if (cell.trim() !== '') out.push(cell);
      if (out.length >= maxCells) return out;
    }
  }
  return out;
}

// --- Record splitting (quote-aware) ------------------------------------------

/** One logical record: the physical line it STARTS on, and its full text. */
interface RawRecord {
  line: number;
  raw: string;
}

/**
 * Split the text into RECORDS, treating a newline inside an open quote as part
 * of the field rather than a record boundary. Returns null when the quoting
 * cannot be trusted, so the caller can fall back to plain physical lines.
 *
 * Splitting on newlines before any quote tracking is what broke IBKR-style
 * exports with embedded newlines in a description: a quoted two-line
 * description produced a TRUNCATED row (its amount gone) plus a phantom row
 * whose first cell was the tail of the description — with `issues: []`.
 *
 * Two failure modes make the quote-aware reading unusable, and both return
 * null rather than a worse table:
 *  - an unterminated quote at EOF (a stray inch-mark, `27" Monitor`), and
 *  - a record running past {@link MAX_RECORD_LINES}, which is the same stray
 *    quote when a second one later in the file happens to close it — without
 *    this bound one typo would merge thousands of lines into one record.
 * The physical-line reading is then exactly what this module did before, plus
 * an `unbalanced-quote` issue so the reduced confidence is visible.
 */
function splitQuotedRecords(physicalLines: string[]): RawRecord[] | null {
  const records: RawRecord[] = [];
  let pending: string[] = [];
  let startLine = 1;
  let inQuotes = false;
  for (let i = 0; i < physicalLines.length; i++) {
    const line = physicalLines[i] ?? '';
    if (pending.length === 0) startLine = i + 1;
    pending.push(line);
    if (pending.length > MAX_RECORD_LINES) return null;
    // `""` (an escaped quote) toggles twice and nets out, exactly as
    // `countUnquoted`/`splitCells` treat it — only an ODD count flips state.
    let quotes = 0;
    for (let j = 0; j < line.length; j++) if (line[j] === '"') quotes += 1;
    if (quotes % 2 === 1) inQuotes = !inQuotes;
    if (inQuotes) continue;
    records.push({ line: startLine, raw: pending.join('\n') });
    pending = [];
  }
  // Anything still pending means a quote was opened and never closed.
  return inQuotes || pending.length > 0 ? null : records;
}

// --- The CSV front-end -------------------------------------------------------

function sniffCsvTable(text: string, options: SniffOptions): SniffedTable | null {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const physicalLines = clean.split(/\r\n|\r|\n/);

  const quotedRecords = splitQuotedRecords(physicalLines);
  const unbalancedQuotes = quotedRecords === null;
  const allRecords: RawRecord[] =
    quotedRecords ?? physicalLines.map((raw, i) => ({ line: i + 1, raw }));

  // Non-blank records keep their physical numbering; blank separators are skipped.
  const lines = allRecords.filter(({ raw }) => raw.trim() !== '');
  if (lines.length === 0) return null;

  const delimiter = sniffTableDelimiter(lines.map((l) => l.raw));
  const split = lines.map((l) => ({
    line: l.line,
    raw: l.raw,
    cells: splitCells(l.raw, delimiter),
  }));

  // Modal cell count across the whole file — preamble lines (fewer cells) fall
  // away, the real table defines the width.
  const widthFreq = new Map<number, number>();
  for (const { cells } of split)
    widthFreq.set(cells.length, (widthFreq.get(cells.length) ?? 0) + 1);
  let modalWidth = 0;
  let modalFreq = 0;
  for (const [width, count] of widthFreq) {
    if (count > modalFreq || (count === modalFreq && width > modalWidth)) {
      modalWidth = width;
      modalFreq = count;
    }
  }

  // SCORE the header candidates rather than taking the first — see
  // scoreHeaderCandidate for the preamble trap this closes. Ties keep the
  // earliest row, which is the old behavior for well-formed single-table files
  // and the documented pick for multi-section statements.
  const modalRows = split.filter(({ cells }) => cells.length === modalWidth);
  let header: { line: number; cells: string[] } | undefined;
  let headerScore = -1;
  modalRows.forEach(({ line, cells }, position) => {
    if (!looksLikeHeader(cells)) return;
    const score = scoreHeaderCandidate(
      // Only the lookahead window is ever inspected — slicing the whole
      // remainder per candidate would be quadratic on a large export.
      modalRows.slice(position + 1, position + 1 + HEADER_LOOKAHEAD).map((r) => r.cells),
      cells,
      options.headerVocabulary,
    );
    if (score === null || score <= headerScore) return;
    header = { line, cells };
    headerScore = score;
  });

  const issues: TableIssue[] = [];
  if (unbalancedQuotes) {
    issues.push({
      kind: 'unbalanced-quote',
      line: -1,
      row: -1,
      message:
        'The quote characters in this file do not pair up, so a quoted field may not end where ' +
        'it looks like it does. Each line was read on its own — check that no description was ' +
        'cut short before importing.',
    });
  }
  const oversized = split.filter(
    ({ raw, cells }) => raw.length > MAX_LINE_CHARS || cells.some(isOversizedCell),
  );
  if (oversized.length > 0) {
    issues.push({
      kind: 'oversized-cell',
      line: oversized[0]!.line,
      row: -1,
      message:
        `Line ${oversized[0]!.line} carries a field longer than ${MAX_CELL_CHARS} characters ` +
        `(${oversized.length} line(s) affected). Those fields were kept as-is but not ` +
        `interpreted as dates, amounts or identifiers — check them before importing.`,
    });
  }
  if (!header) {
    // Failing to label the columns means importing NOTHING from this file. The
    // caller must not be able to mistake that for a clean read, so say which of
    // the two ways it failed and on which line.
    const mismatched = split.find(
      ({ cells }) => cells.length !== modalWidth && looksLikeHeader(cells),
    );
    if (mismatched) {
      issues.push({
        kind: 'header-width-mismatch',
        line: mismatched.line,
        row: -1,
        message:
          `The header row on line ${mismatched.line} has ${mismatched.cells.length} column(s) but ` +
          `the data rows have ${modalWidth} — no column can be matched to a label. ` +
          `Re-export the file with a header covering every column.`,
      });
    } else {
      issues.push({
        kind: 'no-header-row',
        line: -1,
        row: -1,
        message: 'No row in this file looks like a header — its columns are unlabeled.',
      });
    }
  }

  const headers = header?.cells ?? [];
  const rows: string[][] = [];
  const lineNumbers: number[] = [];
  let ragged = 0;
  for (const { line, cells } of split) {
    if (header) {
      // EVERY line above the header is preamble — metadata, not rows — including
      // one at the table's own width (`Konto;Inhaber;Waehrung;Filiale;Typ`),
      // which would otherwise ride along as a bookable row. Below the header,
      // keep every line: ragged data rows still belong to the preview.
      if (line <= header.line) continue;
      // …but a row of a DIFFERENT width than the header is misaligned, and
      // silence about that is a money bug: a 3-cell row under a 5-cell header
      // handed the wizard `{quantity: '-80,00'}` — the AMOUNT read as a
      // quantity of -80 shares — with `issues: []`. Which cells belong to which
      // label is unknowable here, so the row is kept verbatim and reported;
      // padding it would just be a different silent guess.
      if (cells.length !== header.cells.length) {
        ragged += 1;
        if (ragged <= MAX_ROW_ISSUES) {
          issues.push({
            kind: 'row-width-mismatch',
            line,
            row: rows.length,
            message:
              `Line ${line} has ${cells.length} column(s) but the header has ` +
              `${header.cells.length} — its values cannot be matched to labels reliably ` +
              `(an amount can land in a quantity). Check this row before importing.`,
          });
        }
      }
    } else if (cells.length !== modalWidth) {
      continue;
    }
    rows.push(cells);
    lineNumbers.push(line);
  }
  if (ragged > MAX_ROW_ISSUES) {
    issues.push({
      kind: 'row-width-mismatch',
      line: -1,
      row: -1,
      message:
        `${ragged - MAX_ROW_ISSUES} further row(s) also differ from the header's ` +
        `${header?.cells.length ?? 0} column(s).`,
    });
  }

  const samples = sampleCells(rows);
  const { locale: dateLocale, ambiguous, twoDigitYear } = detectDateLocale(samples);
  if (ambiguous) {
    issues.push({
      kind: 'ambiguous-date-locale',
      line: header?.line ?? -1,
      row: -1,
      message:
        'This file writes dates as DD/MM/YYYY or MM/DD/YYYY and nothing in it settles which — ' +
        'e.g. 01/02/2024 is either 1 February or 2 January. Confirm the date order before importing.',
    });
  }
  if (twoDigitYear) {
    issues.push({
      kind: 'two-digit-year',
      line: header?.line ?? -1,
      row: -1,
      message:
        'This file writes dates with a two-digit year (e.g. 15.01.24), so the century is not in ' +
        'the data. Years 00–68 were read as 2000–2068 and 69–99 as 1969–1999 — confirm the ' +
        'years before importing.',
    });
  }
  issues.push(...detectSummaryRows(rows, lineNumbers));

  return {
    delimiter,
    encoding: 'utf-8',
    headerRowIndex: header?.line ?? -1,
    headers,
    rows,
    lineNumbers,
    dateLocale,
    dateLocaleAmbiguous: ambiguous,
    numberLocale: detectNumberLocale(samples, dateLocale),
    defaultCurrency: detectDefaultCurrency(samples),
    issues,
  };
}

const csvTableSniffer: TableSniffer = {
  id: 'csv',

  // Anything that is not a ZIP container (XLSX magic) is CSV territory. A real
  // XLSX front-end claims the ZIP magic + .xlsx suffix instead.
  canSniff(buffer: Uint8Array, filename: string): boolean {
    if (filename.toLowerCase().endsWith('.xlsx')) return false;
    return !(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04);
  },

  sniff(buffer: Uint8Array, _filename: string, options: SniffOptions): SniffedTable | null {
    const decoded = decodeText(buffer);
    const table = sniffCsvTable(decoded.text, options);
    if (!table) return null;
    table.encoding = decoded.encoding;
    // Whole-file property: it comes first, ahead of the per-row findings.
    const issue = encodingIssue(decoded);
    if (issue) table.issues.unshift(issue);
    return table;
  },
};

const SNIFFERS: readonly TableSniffer[] = [csvTableSniffer];

/**
 * Sniff an uploaded file into a normalized table. Returns null for a file with
 * no tabular content at all (empty / blank); throws
 * {@link UnsupportedFileFormatError} when no front-end claims the format
 * (e.g. XLSX until that front-end exists).
 */
export function sniffTable(
  buffer: Uint8Array,
  filename: string,
  options: SniffOptions = {},
): SniffedTable | null {
  const sniffer = SNIFFERS.find((s) => s.canSniff(buffer, filename));
  if (!sniffer) {
    throw new UnsupportedFileFormatError(filename, 'unsupported file format — export as CSV/TSV.');
  }
  return sniffer.sniff(buffer, filename, options);
}

// --- Locale-aware value parsing (consumers of the sniff results) -------------

/**
 * Unmistakably ENGLISH grouping with a decimal point: `1,234.56`. Both
 * separators are present in the one order German notation can never produce,
 * so a cell in this shape is not German — whatever the file's locale says.
 */
const ENGLISH_GROUPED_DECIMAL = /^[+-]?\d{1,3}(,\d{3})+\.\d+$/;

/**
 * Parse a decimal in the table's detected notation. `de` delegates to the
 * framework's `parseDecimal` (German + plain, refuses ambiguous `1.000`);
 * `en` uses the strict English parser, which refuses the mirror-ambiguous
 * grouping forms for the same reason: guessing wrong books ~1000× off.
 *
 * Under `de`, a value in unmistakably English grouping is REFUSED rather than
 * reinterpreted. `parseDecimal('1,234.56')` reads the comma as the decimal
 * separator and returns 1.23456 — silently a thousandth of the real amount,
 * the worst possible outcome for a mis-sniffed file.
 *
 * The guard runs on the DECORATION-STRIPPED value, not the raw cell. Testing
 * the raw cell was the whole defect: `parseDecimal` strips currency symbols and
 * letters BEFORE parsing, so a fully anchored pattern only ever saw bare
 * numbers and every decorated amount walked straight past it —
 * `'1,234.56 EUR'`, `'$1,234.56'` and `'1,234.56 €'` all returned 1.23456 while
 * the bare `'1,234.56'` (the only form the original tests covered) was refused.
 * Decorated amounts are first-class here: `'-751,00 EUR'` is a supported German
 * cell, so its English mirror `'-751.00 EUR'` must parse too rather than
 * silently returning null.
 */
export function parseLocalizedDecimal(input: string, locale: NumberLocale): number | null {
  if (input.length > MAX_CELL_CHARS) return null;
  const bare = stripDecimalDecoration(input);
  if (bare === null) return null;
  if (locale === 'de') {
    if (ENGLISH_GROUPED_DECIMAL.test(bare)) return null;
    return parseDecimal(input);
  }
  return parseEnglishDecimal(input);
}

/**
 * Parse an ENGLISH-notation decimal (`1,234.56` — dot decimal, comma
 * thousands), currency decoration and all (`'$1,234.56'`, `'-751.00 EUR'`) —
 * the same contract `parseDecimal` gives the German side, so a decorated cell
 * is not silently lost in one locale and read in the other.
 *
 * Two forms are refused as AMBIGUOUS rather than guessed at:
 *  - `1.000` — a grouping-dot integer: German 1000 or English 1.0.
 *  - `1,250` — a SINGLE comma group with no decimal point: English 1250 or
 *    German 1.25. This is the exact mirror of the case above and refusing it is
 *    the same trade (one reported row instead of a 1000× booking). A German
 *    file whose `Stück` column reads `1,250 / 2,750 / 0,500` used to be read as
 *    [1250, 2750, 500] whenever anything tipped the file to `en`.
 * Multi-group integers (`1,234,567`) are unambiguous — no notation but English
 * produces two comma groups — and still parse.
 */
export function parseEnglishDecimal(input: string): number | null {
  if (input.length > MAX_CELL_CHARS) return null;
  let cleaned = stripDecimalDecoration(input);
  if (cleaned === null) return null;
  const sign = cleaned.startsWith('-') ? -1 : 1;
  cleaned = cleaned.replace(/^[+-]/, '');
  if (/[+-]/.test(cleaned)) return null;
  if (cleaned.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) return null;
    if (AMBIGUOUS_COMMA_GROUP.test(cleaned)) return null; // `1,250`: 1250 or 1.25?
    cleaned = cleaned.replace(/,/g, '');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    return null; // ambiguous: German 1000 or English 1.0 — see parseDecimal
  }
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? sign * value : null;
}

/**
 * Parse a calendar day in the table's detected notation, anchored at 12:00 UTC
 * exactly like `parseDay`. The slash locales rewrite to ISO first (the
 * framework parser deliberately does not guess slash formats): `us` reads
 * MM/DD/YYYY, `eu-slash` reads DD/MM/YYYY. Which of the two a file uses comes
 * from {@link SniffedTable.dateLocale} — and when
 * {@link SniffedTable.dateLocaleAmbiguous} is set, the answer was a guess and
 * the row must not be booked unattended.
 *
 * Under `de` the two-digit-year form (`15.01.24`) is read as well, with the
 * century inferred by {@link expandTwoDigitYear}. Refusing it outright would
 * mean every date in such a file coming back null — the failure the sniffer
 * used to hide behind a clean report — so it parses, and the file carries a
 * `two-digit-year` issue saying the century was not in the data.
 */
export function parseLocalizedDay(input: string, locale: DateLocale): Date | null {
  if (input.length > MAX_CELL_CHARS) return null;
  if (locale === 'us' || locale === 'eu-slash') {
    const match = SLASH_DAY_SAMPLE.exec(input.trim());
    if (!match) return null;
    const [, first, second, y] = match as unknown as [string, string, string, string];
    const [month, day] = locale === 'us' ? [first, second] : [second, first];
    return parseDay(`${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  }
  if (locale === 'de') {
    const short = parseGermanShortDay(input);
    if (short !== null) return short;
  }
  return parseDay(input);
}
