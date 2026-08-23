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

/** Date notation a file's data rows use (sampled, never taken from the header). */
export type DateLocale = 'iso' | 'de' | 'us';

/** Decimal notation a file's data rows use. */
export type NumberLocale = 'de' | 'en';

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
  numberLocale: NumberLocale;
  /** Majority ISO currency seen in the data rows, `EUR` when none (the cash ledger is EUR-only, §14). */
  defaultCurrency: string;
}

/** Thrown when no sniff front-end can claim the buffer (e.g. an XLSX today). */
export class UnsupportedFileFormatError extends Error {
  constructor(filename: string, reason: string) {
    super(`Cannot import "${filename}": ${reason}`);
    this.name = 'UnsupportedFileFormatError';
  }
}

/**
 * One sniff front-end. CSV is the only implementation in this task; an XLSX
 * front-end registers here later and `sniffTable` dispatches without the
 * mapper ever knowing the difference.
 */
export interface TableSniffer {
  readonly id: 'csv' | 'xlsx';
  canSniff(buffer: Uint8Array, filename: string): boolean;
  sniff(buffer: Uint8Array, filename: string): SniffedTable | null;
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
    throw new UnsupportedFileFormatError('(buffer)', 'UTF-16BE encoding is not supported — re-export as UTF-8.');
  }
  return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
}

// --- Header-row detection ----------------------------------------------------

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const US_DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s].*)?$/;

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
 * The header row is the first row whose cell count matches the modal cell
 * count AND whose cells look like labels: mostly non-empty, none parsing as a
 * date/decimal/ISIN, at least one carrying letters.
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

const ISO_DAY_SAMPLE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/;
const GERMAN_DAY_SAMPLE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[T\s].*)?$/;

/** Detect the date notation by sampling data cells; `iso` on no evidence. */
function detectDateLocale(cells: string[]): DateLocale {
  let iso = 0;
  let de = 0;
  let us = 0;
  for (const raw of cells) {
    const cell = trimTrailingPunctuation(raw);
    if (ISO_DAY_SAMPLE.test(cell) && parseDay(cell) !== null) iso += 1;
    else if (GERMAN_DAY_SAMPLE.test(cell) && parseDay(cell) !== null) de += 1;
    else if (US_DAY.test(cell)) us += 1;
  }
  if (iso >= de && iso >= us) return 'iso';
  if (de > us) return 'de';
  return 'us';
}

/**
 * Detect the decimal notation. Decimal commas and grouping dots vote German,
 * decimal dots and grouping commas vote English; an ambiguous grouping-dot
 * integer (`1.000`) counts HALF each — csv.ts refuses to parse it either way,
 * so it must not tip the locale. Calendar dates NEVER vote: a German date's
 * dots are separators, not decimals.
 */
function isCalendarDaySample(cell: string): boolean {
  const trimmed = trimTrailingPunctuation(cell);
  return (
    (ISO_DAY_SAMPLE.test(trimmed) || GERMAN_DAY_SAMPLE.test(trimmed) || US_DAY.test(trimmed)) &&
    true
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

/** Common ISO-4217 codes a broker/bank export carries (structural + membership, not the full list). */
const ISO_CURRENCIES = new Set([
  'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'CNY', 'HKD', 'SGD', 'ZAR', 'MXN', 'BRL',
  'INR', 'KRW', 'THB', 'MYR', 'IDR', 'PHP', 'AED', 'ILS',
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

function sniffCsvTable(text: string): SniffedTable | null {
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
  for (const { cells } of split) widthFreq.set(cells.length, (widthFreq.get(cells.length) ?? 0) + 1);
  let modalWidth = 0;
  let modalFreq = 0;
  for (const [width, count] of widthFreq) {
    if (count > modalFreq || (count === modalFreq && width > modalWidth)) {
      modalWidth = width;
      modalFreq = count;
    }
  }

  const header = split.find(({ cells }) => cells.length === modalWidth && looksLikeHeader(cells));

  const headers = header?.cells ?? [];
  const rows: string[][] = [];
  const lineNumbers: number[] = [];
  for (const { line, cells } of split) {
    if (header) {
      // Preamble lines above the header are metadata, not rows; below it, keep
      // every line — ragged data rows still belong to the preview.
      if (cells === header.cells) continue;
      if (line < header.line && cells.length !== modalWidth) continue;
    } else if (cells.length !== modalWidth) {
      continue;
    }
    rows.push(cells);
    lineNumbers.push(line);
  }

  const samples = sampleCells(rows);
  const dateLocale = detectDateLocale(samples);
  return {
    delimiter,
    encoding: 'utf-8',
    headerRowIndex: header?.line ?? -1,
    headers,
    rows,
    lineNumbers,
    dateLocale,
    numberLocale: detectNumberLocale(samples, dateLocale),
    defaultCurrency: detectDefaultCurrency(samples),
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

  sniff(buffer: Uint8Array): SniffedTable | null {
    const { text, encoding } = decodeText(buffer);
    const table = sniffCsvTable(text);
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
export function sniffTable(buffer: Uint8Array, filename: string): SniffedTable | null {
  const sniffer = SNIFFERS.find((s) => s.canSniff(buffer, filename));
  if (!sniffer) {
    throw new UnsupportedFileFormatError(filename, 'unsupported file format — export as CSV/TSV.');
  }
  return sniffer.sniff(buffer, filename);
}

// --- Locale-aware value parsing (consumers of the sniff results) -------------

/**
 * Parse a decimal in the table's detected notation. `de` delegates to the
 * framework's `parseDecimal` (German + plain, refuses ambiguous `1.000`);
 * `en` uses the strict English parser, which refuses the mirror-ambiguous
 * grouping-dot form for the same reason: guessing wrong books ~1000× off.
 */
export function parseLocalizedDecimal(input: string, locale: NumberLocale): number | null {
  if (locale === 'de') return parseDecimal(input);
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
 * exactly like `parseDay`. `us` rewrites MM/DD/YYYY to ISO first (the framework
 * parser deliberately does not guess slash formats).
 */
export function parseLocalizedDay(input: string, locale: DateLocale): Date | null {
  if (locale === 'us') {
    const match = US_DAY.exec(input.trim());
    if (!match) return null;
    const [, m, d, y] = match;
    return parseDay(`${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`);
  }
  return parseDay(input);
}
