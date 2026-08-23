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

import { countUnquoted, parseDay, parseDecimal, splitCells } from './csv';

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
  /** A row that totals the ones above it (`Summe;;450,00`) — NOT a booking. */
  | 'summary-row'
  /** Slash dates whose day/month order the data cannot settle (all parts ≤ 12). */
  | 'ambiguous-date-locale';

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
  encoding: 'utf-8' | 'utf-16le';
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

/** Decode the buffer, stripping the BOM. UTF-16BE is refused (no broker ships it). */
function decodeText(buffer: Uint8Array): { text: string; encoding: SniffedTable['encoding'] } {
  const startsWith = (bom: number[]): boolean => bom.every((b, i) => buffer[i] === b);
  if (startsWith(UTF8_BOM)) {
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
  }
  if (startsWith(UTF16LE_BOM)) {
    return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le' };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new UnsupportedFileFormatError(
      '(buffer)',
      'UTF-16BE encoding is not supported — re-export as UTF-8.',
    );
  }
  return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
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
  if (parseDay(trimTrailingPunctuation(cell)) !== null) return true;
  if (parseDecimal(cell) !== null) return true;
  if (parseEnglishDecimal(cell) !== null) return true;
  return ISIN_PATTERN.test(cell);
}

/**
 * `Date/Time` values arrive quoted with a trailing comma inside the cell
 * (`"2024-01-16, 09:32:11"`); the calendar day before the comma is what a date
 * check must see. Only trailing punctuation is dropped — a leading one would
 * change the number.
 */
function trimTrailingPunctuation(cell: string): string {
  return cell.replace(/[.,;]+$/, '').trim();
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

/** The date notation plus whether the slash ORDER had to be guessed. */
interface DateLocaleEvidence {
  locale: DateLocale;
  ambiguous: boolean;
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
  for (const raw of cells) {
    const cell = trimTrailingPunctuation(raw);
    if (ISO_DAY_SAMPLE.test(cell) && parseDay(cell) !== null) {
      iso += 1;
      continue;
    }
    if (GERMAN_DAY_SAMPLE.test(cell) && parseDay(cell) !== null) {
      de += 1;
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
  if (iso >= de && iso >= slash) return { locale: 'iso', ambiguous: false };
  if (de > slash) return { locale: 'de', ambiguous: false };
  if (monthFirstProof > 0 && dayFirstProof === 0) return { locale: 'us', ambiguous: false };
  if (dayFirstProof > 0 && monthFirstProof === 0) return { locale: 'eu-slash', ambiguous: false };
  // Either no component ever exceeded 12, or the file contradicts itself. Both
  // are unresolvable here; day-first is the reading of BetterTrack's home
  // market (§14) and the ambiguity flag keeps it out of unattended booking.
  return { locale: monthFirstProof > dayFirstProof ? 'us' : 'eu-slash', ambiguous: true };
}

/**
 * Detect the decimal notation. Decimal commas and grouping dots vote German,
 * decimal dots and grouping commas vote English; an ambiguous grouping-dot
 * integer (`1.000`) counts HALF each — csv.ts refuses to parse it either way,
 * so it must not tip the locale. Calendar dates NEVER vote: a German date's
 * dots are separators, not decimals.
 */
export function isCalendarDaySample(cell: string): boolean {
  const trimmed = trimTrailingPunctuation(cell);
  return (
    ISO_DAY_SAMPLE.test(trimmed) ||
    GERMAN_DAY_SAMPLE.test(trimmed) ||
    SLASH_DAY_SAMPLE.test(trimmed)
  );
}

function detectNumberLocale(cells: string[], dateLocale: DateLocale): NumberLocale {
  let de = 0;
  let en = 0;
  for (const raw of cells) {
    if (isCalendarDaySample(raw)) continue;
    const cell = trimTrailingPunctuation(raw);
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
  return cells.some((c) => parseDay(trimTrailingPunctuation(c)) !== null);
}

function rowHasDecimal(cells: string[]): boolean {
  return cells.some((c) => parseDecimal(c) !== null || parseEnglishDecimal(c) !== null);
}

function rowHasSummaryWord(cells: string[]): boolean {
  return cells.some((cell) => {
    const normalized = cell
      .trim()
      .toLowerCase()
      .replace(/[.:;]+$/, '');
    if (normalized === '') return false;
    if (SUMMARY_WORDS.has(normalized)) return true;
    const first = normalized.split(/[\s_]+/)[0] ?? '';
    return SUMMARY_WORDS.has(first);
  });
}

/**
 * Flag rows that TOTAL the ones around them (`Summe;;450,00`, IBKR's
 * `Total,,,2100`). Booked as transactions they are phantom money — the sum
 * lands in the ledger a second time — so they are reported, never silently
 * kept as ordinary data.
 *
 * All three signals must agree: no calendar day anywhere in the row (a real
 * booking is dated), a summary word, and a number to total. The detector also
 * needs the file to date its other rows at all, otherwise datelessness carries
 * no information. Rows are FLAGGED, not dropped: silently discarding a row the
 * user can see in their file is the mirror-image bug.
 */
function detectSummaryRows(rows: string[][], lineNumbers: number[]): TableIssue[] {
  if (rows.length < 2 || !rows.some(rowHasDay)) return [];
  const issues: TableIssue[] = [];
  rows.forEach((cells, index) => {
    if (rowHasDay(cells)) return;
    if (!rowHasSummaryWord(cells) || !rowHasDecimal(cells)) return;
    issues.push({
      kind: 'summary-row',
      line: lineNumbers[index] ?? -1,
      row: index,
      message:
        `Line ${lineNumbers[index] ?? '?'} totals the rows around it instead of booking a ` +
        `transaction — importing it would double-count that amount.`,
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

// --- The CSV front-end -------------------------------------------------------

function sniffCsvTable(text: string, options: SniffOptions): SniffedTable | null {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const physicalLines = clean.split(/\r\n|\r|\n/);

  // Non-blank lines keep their physical numbering; blank separators are skipped.
  const lines: { line: number; raw: string }[] = [];
  physicalLines.forEach((raw, i) => {
    if (raw.trim() !== '') lines.push({ line: i + 1, raw });
  });
  if (lines.length === 0) return null;

  const delimiter = sniffTableDelimiter(lines.map((l) => l.raw));
  const split = lines.map((l) => ({ line: l.line, cells: splitCells(l.raw, delimiter) }));

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
  for (const { line, cells } of split) {
    if (header) {
      // EVERY line above the header is preamble — metadata, not rows — including
      // one at the table's own width (`Konto;Inhaber;Waehrung;Filiale;Typ`),
      // which would otherwise ride along as a bookable row. Below the header,
      // keep every line: ragged data rows still belong to the preview.
      if (line <= header.line) continue;
    } else if (cells.length !== modalWidth) {
      continue;
    }
    rows.push(cells);
    lineNumbers.push(line);
  }

  const samples = sampleCells(rows);
  const { locale: dateLocale, ambiguous } = detectDateLocale(samples);
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
    const { text, encoding } = decodeText(buffer);
    const table = sniffCsvTable(text, options);
    if (table) table.encoding = encoding;
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
 * grouping-dot form for the same reason: guessing wrong books ~1000× off.
 *
 * Under `de`, a value in unmistakably English grouping is REFUSED rather than
 * reinterpreted. `parseDecimal('1,234.56')` reads the comma as the decimal
 * separator and returns 1.23456 — silently a thousandth of the real amount,
 * the worst possible outcome for a mis-sniffed file. The English parser already
 * refuses the mirror case (`1.234,56` under `en`), so both directions now cost
 * one reported row instead of a wrong booking.
 */
export function parseLocalizedDecimal(input: string, locale: NumberLocale): number | null {
  if (locale === 'de') {
    if (ENGLISH_GROUPED_DECIMAL.test(input.trim())) return null;
    return parseDecimal(input);
  }
  return parseEnglishDecimal(input);
}

/**
 * Parse an ENGLISH-notation decimal (`1,234.56` — dot decimal, comma
 * thousands). Grouping commas must match the 3-digit pattern exactly; a
 * grouping-dot integer without a decimal (`1.000`) is refused as ambiguous,
 * mirroring `parseDecimal`'s German-notation refusal.
 */
export function parseEnglishDecimal(input: string): number | null {
  let cleaned = input.trim();
  if (cleaned === '') return null;
  if (cleaned.includes('(') || cleaned.includes(')')) return null;
  const sign = cleaned.startsWith('-') ? -1 : 1;
  cleaned = cleaned.replace(/^[+-]/, '');
  if (/[+-]/.test(cleaned)) return null;
  if (cleaned.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) return null;
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
 */
export function parseLocalizedDay(input: string, locale: DateLocale): Date | null {
  if (locale === 'us' || locale === 'eu-slash') {
    const match = SLASH_DAY_SAMPLE.exec(input.trim());
    if (!match) return null;
    const [, first, second, y] = match as unknown as [string, string, string, string];
    const [month, day] = locale === 'us' ? [first, second] : [second, first];
    return parseDay(`${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  }
  return parseDay(input);
}
