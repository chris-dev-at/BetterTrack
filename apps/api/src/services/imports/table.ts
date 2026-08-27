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

import {
  countUnquoted,
  isFieldPadding,
  parseDay,
  parseDecimal,
  splitCells,
  stripDecimalDecoration,
} from './csv';

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
  /** A DATA row whose cells are genuinely MISALIGNED against the header. */
  | 'row-width-mismatch'
  /**
   * The quiet sibling of `row-width-mismatch`: a data row shorter than the
   * header that only omits TRAILING columns the file itself leaves empty
   * elsewhere, with every value it does carry still sitting under a label of the
   * right shape. That is ordinary raggedness, not a money bug, and firing the
   * loud kind on it trains operators to ignore the loud kind.
   */
  | 'trailing-cells-omitted'
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
  | 'oversized-cell'
  /**
   * A cell in an unreadable GROUPED notation (`1,250` under `en`, `1.000` under
   * either) — the parsers refuse it rather than book a value ~1000× off, so the
   * cell comes back null. Without this kind that refusal was invisible: a
   * `Quantity` column of `1,250 / 2,750 / 500` reported 0.95 confidence,
   * `needsReview: false` and `issues: []` while two of its three share counts
   * silently parsed to null.
   */
  | 'ambiguous-grouped-number';

export interface TableIssue {
  kind: TableIssueKind;
  /** Physical 1-based line the issue points at; -1 for a whole-file property. */
  line: number;
  /** Index into {@link SniffedTable.rows} when the issue points at one; -1 otherwise. */
  row: number;
  /**
   * Index into {@link SniffedTable.headers} (and into each row's cells) when the
   * issue points at ONE column; -1 otherwise. The column mapper reads this to
   * force `needsReview` on the affected column.
   */
  column: number;
  /** Operator-facing explanation — safe to surface in the import wizard. */
  message: string;
}

/**
 * The row-level kinds, i.e. the ones a downstream row classifier must be able to
 * join to an individual row. Deliberately EXCLUDES `trailing-cells-omitted`:
 * the whole point of splitting that kind out of `row-width-mismatch` is that it
 * does not force a human to look at the row, and feeding it into the classifier
 * (which forces review on any non-empty flag list) would undo the split.
 */
const ROW_FLAG_KINDS: ReadonlySet<TableIssueKind> = new Set<TableIssueKind>([
  'summary-row',
  'row-width-mismatch',
  'ambiguous-grouped-number',
  'oversized-cell',
]);

/**
 * Everything the sniff noticed about ONE row, in a shape a row classifier can
 * join on. The parallel row classifier takes `sniffFlags?: readonly string[]`
 * per row and forces review when it is non-empty, so {@link RowFlag.flags} is
 * exactly that array and {@link RowFlag.row} is the index into
 * {@link SniffedTable.rows} it belongs to.
 *
 * Unlike {@link SniffedTable.issues} this list is NEVER capped. The cap on
 * issues exists so a wholly ragged file cannot drown an operator in thousands
 * of messages; applying it here would leave rows 26+ of that same file looking
 * clean to the machine, which is precisely the "confidently wrong" outcome this
 * module exists to prevent.
 */
export interface RowFlag {
  /** Index into {@link SniffedTable.rows}. */
  row: number;
  /** Physical 1-based line the row came from — the same audit trail as `lineNumbers`. */
  line: number;
  /** The row-level issue kinds affecting this row, deduped and sorted. */
  flags: TableIssueKind[];
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
  /**
   * Per-row findings for a downstream row classifier — one entry per AFFECTED
   * row, complete (never capped), sorted by row. See {@link RowFlag}. Empty on
   * a clean file. Join it with {@link sniffFlagsByRow}.
   */
  rowFlags: RowFlag[];
}

/**
 * Index {@link SniffedTable.rowFlags} by row so a caller iterating rows can look
 * each one up in O(1) instead of scanning. Rows with nothing to report are
 * absent, so `map.get(i) ?? []` is the whole join.
 */
export function sniffFlagsByRow(table: SniffedTable): Map<number, readonly TableIssueKind[]> {
  return new Map(table.rowFlags.map((f) => [f.row, f.flags]));
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
  /** Bytes that were not valid UTF-8 and were therefore read as Windows-1252. */
  legacyBytes: number;
  /** Valid MULTI-BYTE UTF-8 characters — the counter-evidence to those bytes. */
  utf8NonAscii: number;
  /** True when the decoded text still carries U+FFFD — bytes were genuinely lost. */
  lostCharacters: boolean;
}

/**
 * Windows-1252 for one byte, built once from the platform decoder rather than
 * from a hand-typed table (0x80–0x9F is exactly the range a hand-typed table
 * gets wrong, and it is the range this repair exists for: 0x92 is `’`).
 */
const CP1252_BY_BYTE: readonly string[] = (() => {
  const decoder = new TextDecoder('windows-1252');
  const table: string[] = [];
  for (let byte = 0; byte < 256; byte++) table.push(decoder.decode(Uint8Array.of(byte)));
  return table;
})();

/**
 * Length of the valid UTF-8 sequence starting at `i`, or 0 when the byte cannot
 * start one. RFC 3629 exactly: overlong forms, UTF-16 surrogates (ED A0–BF) and
 * anything above U+10FFFF (F5–FF) are NOT valid and must be reported as 0, or
 * the repair below would hand `TextDecoder` bytes it rejects.
 */
function utf8SequenceLength(bytes: Uint8Array, i: number): number {
  const b0 = bytes[i]!;
  if (b0 < 0x80) return 1;
  const cont = (offset: number, lo: number, hi: number): boolean => {
    const b = bytes[i + offset];
    return b !== undefined && b >= lo && b <= hi;
  };
  if (b0 >= 0xc2 && b0 <= 0xdf) return cont(1, 0x80, 0xbf) ? 2 : 0;
  if (b0 === 0xe0) return cont(1, 0xa0, 0xbf) && cont(2, 0x80, 0xbf) ? 3 : 0;
  if (b0 >= 0xe1 && b0 <= 0xec) return cont(1, 0x80, 0xbf) && cont(2, 0x80, 0xbf) ? 3 : 0;
  if (b0 === 0xed) return cont(1, 0x80, 0x9f) && cont(2, 0x80, 0xbf) ? 3 : 0;
  if (b0 === 0xee || b0 === 0xef) return cont(1, 0x80, 0xbf) && cont(2, 0x80, 0xbf) ? 3 : 0;
  if (b0 === 0xf0) {
    return cont(1, 0x90, 0xbf) && cont(2, 0x80, 0xbf) && cont(3, 0x80, 0xbf) ? 4 : 0;
  }
  if (b0 >= 0xf1 && b0 <= 0xf3) {
    return cont(1, 0x80, 0xbf) && cont(2, 0x80, 0xbf) && cont(3, 0x80, 0xbf) ? 4 : 0;
  }
  if (b0 === 0xf4) {
    return cont(1, 0x80, 0x8f) && cont(2, 0x80, 0xbf) && cont(3, 0x80, 0xbf) ? 4 : 0;
  }
  return 0;
}

/**
 * Repair a buffer that is not wholly valid UTF-8, PER BYTE: every valid UTF-8
 * run is decoded as UTF-8 and only the bytes that cannot start or continue a
 * sequence are read as Windows-1252.
 *
 * The whole-buffer re-read this replaces punished a file for one bad byte. A
 * predominantly-UTF-8 German export carrying a single legacy `0x92` smart quote
 * in one memo had EVERY multi-byte character re-read as cp1252: `Stück` became
 * `StÃ¼ck`, `Gebühr` became `GebÃ¼hr`, both matched no alias, both landed in
 * `unmapped`, and quantity and fee dropped out of `fieldWinners` entirely —
 * the exact loss the fatal-decode fix existed to prevent, in the opposite
 * direction. Byte-level repair keeps every valid character AND recovers the
 * stray one (`0x92` → `’`), so neither direction loses data.
 */
function repairMixedEncoding(buffer: Uint8Array): {
  text: string;
  legacyBytes: number;
  utf8NonAscii: number;
} {
  // Non-fatal on purpose: every run handed to it is valid by the scanner above,
  // so the output is identical — but if the scanner were ever wrong, a run
  // degrades to U+FFFD (which `lostCharacters` reports) instead of throwing.
  const decoder = new TextDecoder('utf-8');
  const parts: string[] = [];
  let runStart = 0;
  let legacyBytes = 0;
  let utf8NonAscii = 0;
  let i = 0;
  while (i < buffer.length) {
    const length = utf8SequenceLength(buffer, i);
    if (length === 0) {
      if (i > runStart) parts.push(decoder.decode(buffer.subarray(runStart, i)));
      parts.push(CP1252_BY_BYTE[buffer[i]!]!);
      legacyBytes += 1;
      i += 1;
      runStart = i;
      continue;
    }
    if (length > 1) utf8NonAscii += 1;
    i += length;
  }
  if (i > runStart) parts.push(decoder.decode(buffer.subarray(runStart, i)));
  return { text: parts.join(''), legacyBytes, utf8NonAscii };
}

/**
 * Decode the buffer, stripping the BOM. UTF-16BE is refused (no broker ships
 * it).
 *
 * A BOM is a DECLARATION and is trusted. Without one, UTF-8 is tried in FATAL
 * mode: a non-fatal decode turns every non-UTF-8 byte into U+FFFD and reports
 * the file as clean `utf-8`, so an ISO-8859-1 export — routine for German bank
 * CSVs — arrived with headers `Geb?hr` and `St?ck`, which matched no alias,
 * landed in `unmapped`, and dropped the fee and quantity columns entirely while
 * `issues` stayed empty.
 *
 * When the fatal decode fails, {@link repairMixedEncoding} reads only the
 * offending BYTES as Windows-1252 (the practical superset of ISO-8859-1:
 * identical for the umlauts, and it fills in 0x80–0x9F). The two candidate
 * readings are then SCORED against each other to name the file's encoding:
 * legacy bytes versus valid multi-byte UTF-8 characters. A genuine cp1252
 * export has many of the former and none of the latter and is reported as
 * `windows-1252`; a UTF-8 file with a stray byte is the mirror and stays
 * `utf-8`. Either way the caller gets an `encoding-fallback` issue, because the
 * cp1252 reading is an INFERENCE — the byte 0xE4 is `ä` in Windows-1252 and
 * something else in Windows-1250.
 */
function decodeText(buffer: Uint8Array): DecodedText {
  const startsWith = (bom: number[]): boolean => bom.every((b, i) => buffer[i] === b);
  const finish = (
    text: string,
    encoding: SniffedTable['encoding'],
    legacyBytes: number,
    utf8NonAscii: number,
  ): DecodedText => ({
    text,
    encoding,
    legacyBytes,
    utf8NonAscii,
    lostCharacters: text.includes(REPLACEMENT_CHARACTER),
  });

  if (startsWith(UTF8_BOM)) {
    return finish(new TextDecoder('utf-8').decode(buffer), 'utf-8', 0, 0);
  }
  if (startsWith(UTF16LE_BOM)) {
    return finish(new TextDecoder('utf-16le').decode(buffer), 'utf-16le', 0, 0);
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new UnsupportedFileFormatError(
      '(buffer)',
      'UTF-16BE encoding is not supported — re-export as UTF-8.',
    );
  }
  try {
    // Valid-but-unusual UTF-8 (CJK, emoji, combining marks) takes this path and
    // is never second-guessed.
    return finish(new TextDecoder('utf-8', { fatal: true }).decode(buffer), 'utf-8', 0, 0);
  } catch {
    const { text, legacyBytes, utf8NonAscii } = repairMixedEncoding(buffer);
    // Ties go to UTF-8: the fallback is the inference, so it has to WIN the
    // comparison to be allowed to name the file.
    const encoding = legacyBytes > utf8NonAscii ? 'windows-1252' : 'utf-8';
    return finish(text, encoding, legacyBytes, utf8NonAscii);
  }
}

/** The issue a decode owes the caller, or null when the bytes spoke for themselves. */
function encodingIssue(decoded: DecodedText): TableIssue | null {
  if (decoded.legacyBytes > 0 && decoded.encoding === 'windows-1252') {
    return {
      kind: 'encoding-fallback',
      line: -1,
      row: -1,
      column: -1,
      message:
        'This file is not valid UTF-8, so it was read as Windows-1252 (the usual encoding for ' +
        'German bank exports). Check that accented characters look right — if they do not, ' +
        're-export the file as UTF-8.',
    };
  }
  if (decoded.legacyBytes > 0) {
    return {
      kind: 'encoding-fallback',
      line: -1,
      row: -1,
      column: -1,
      message:
        `This file is UTF-8 apart from ${decoded.legacyBytes} byte(s), which were read as ` +
        'Windows-1252 instead (typically a smart quote or a dash pasted in from Word). Every ' +
        'other character was kept as written — check those spots before importing.',
    };
  }
  if (decoded.lostCharacters) {
    return {
      kind: 'encoding-fallback',
      line: -1,
      row: -1,
      column: -1,
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
 * `01/15/24` — the two-digit-year slash day, in either component order like its
 * four-digit sibling {@link SLASH_DAY_SAMPLE}. Without it a file written wholly
 * in this notation matched NO date sample at all: `detectDateLocale` saw zero
 * evidence of anything, fell through to its `iso` default, reported
 * `issues: []`, and then every single date in the file parsed to null.
 */
export const SLASH_SHORT_DAY_SAMPLE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?:[T\s].*)?$/;

/**
 * Two-digit year → full year. The century is NOT in the file, so this is an
 * inference, not a reading: 00–68 → 2000s, 69–99 → 1900s (the POSIX `%y`
 * pivot) — EXCEPT that the result is never allowed to land in the future.
 *
 * The bare POSIX pivot maps 26–68 to 2026–2068, so `15.01.30` booked a
 * transaction four years from now. A portfolio importer cannot survive that: a
 * future-dated booking sits outside every holdings window, drags the time
 * series to a date with no prices, and cannot be reconciled against a statement
 * that has already been issued. Nobody imports a trade that has not happened
 * yet, so a century that would produce one is the wrong century. The cost is
 * that 1968-and-earlier is unrepresentable in two digits, which no broker
 * export needs.
 *
 * (Deliberate edge: a settlement date in the first days of NEXT calendar year,
 * written two-digit, is pushed back a century. It is compared at YEAR
 * granularity so a date later in the CURRENT year still reads normally, and the
 * file's `two-digit-year` issue tells the operator the century was chosen for
 * them either way.)
 */
function expandTwoDigitYear(yy: string): number {
  const n = Number(yy);
  const pivoted = n <= 68 ? 2000 + n : 1900 + n;
  return pivoted > new Date().getUTCFullYear() ? pivoted - 100 : pivoted;
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
 *
 * `twoDigitYear` is a property of the FILE, not of the winning notation, and is
 * returned from every branch. Pinning it to the German branch alone was a
 * silent-loss bug: a file mixing `2024-01-15` with `17.01.24` sniffed `iso`
 * with `issues: []`, and the short date — which the ISO reading cannot
 * parse — came back null with nothing anywhere saying so.
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
    const long = SLASH_DAY_SAMPLE.exec(cell);
    const short = long ? null : SLASH_SHORT_DAY_SAMPLE.exec(cell);
    const match = long ?? short;
    if (!match) continue;
    slash += 1;
    if (short) twoDigitYear += 1;
    const [, first, second, rawYear] = match as unknown as [string, string, string, string];
    // The order proof needs a real four-digit year to check the day against.
    const year = short ? String(expandTwoDigitYear(rawYear)) : rawYear;
    // A component above 12 is a day — but only counts as proof when reading it
    // that way yields a real calendar date (a broken cell must not flip a file).
    if (Number(first) > 12 && Number(second) <= 12 && isRealDay(year, second, first)) {
      dayFirstProof += 1;
    } else if (Number(second) > 12 && Number(first) <= 12 && isRealDay(year, first, second)) {
      monthFirstProof += 1;
    }
  }
  const short = twoDigitYear > 0;
  if (iso >= de && iso >= slash) return { locale: 'iso', ambiguous: false, twoDigitYear: short };
  if (de > slash) return { locale: 'de', ambiguous: false, twoDigitYear: short };
  if (monthFirstProof > 0 && dayFirstProof === 0)
    return { locale: 'us', ambiguous: false, twoDigitYear: short };
  if (dayFirstProof > 0 && monthFirstProof === 0)
    return { locale: 'eu-slash', ambiguous: false, twoDigitYear: short };
  // Either no component ever exceeded 12, or the file contradicts itself. Both
  // are unresolvable here; day-first is the reading of BetterTrack's home
  // market (§14) and the ambiguity flag keeps it out of unattended booking.
  return {
    locale: monthFirstProof > dayFirstProof ? 'us' : 'eu-slash',
    ambiguous: true,
    twoDigitYear: short,
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
    SLASH_DAY_SAMPLE.test(trimmed) ||
    SLASH_SHORT_DAY_SAMPLE.test(trimmed)
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

/** `1,250` / `1.000` / `1.234.567` — grouped digits with NO decimal separator. */
const GROUPED_INTEGER = /^[+-]?\d{1,3}([.,]\d{3})+$/;
/** `1,234.56` / `1.234,56` — grouped digits WITH the other separator as decimal. */
const GROUPED_DECIMAL = /^[+-]?\d{1,3}([.,]\d{3})+[.,]\d+$/;

/**
 * Is this cell a GROUPED number that the file's notation cannot read?
 *
 * `parseLocalizedDecimal` refuses these on purpose — `1,250` is 1250 in English
 * and 1.25 in German, and guessing books a quantity ~1000× off — but that
 * refusal used to be completely invisible. A genuine English CSV whose Quantity
 * column read `1,250 / 2,750 / 500` came back with the column mapped at 0.95
 * confidence, `needsReview: false`, `unmapped: []` and `issues: []` while two of
 * its three share counts parsed to null. A caller gating on
 * `issues.length === 0` got a green light on unreadable share counts.
 *
 * Only cells that are unmistakably grouped numbers qualify, so an ordinary
 * description carrying digits is never flagged, and a calendar day (whose dots
 * are separators, not grouping) is excluded outright.
 */
export function isAmbiguousGroupedNumber(cell: string, locale: NumberLocale): boolean {
  if (isOversizedCell(cell)) return false;
  if (isCalendarDaySample(cell)) return false;
  const bare = stripDecimalDecoration(cell);
  if (bare === null) return false;
  if (!GROUPED_INTEGER.test(bare) && !GROUPED_DECIMAL.test(bare)) return false;
  return parseLocalizedDecimal(cell, locale) === null;
}

/**
 * The coarse VALUE SHAPE of a cell, used to tell an ordinary short row (whose
 * values still sit under labels of the right kind) from a genuinely misaligned
 * one (whose amount slid into the quantity column). Deliberately locale-blind:
 * both notations are accepted, because the question here is "is this a number
 * at all", not "what number is it".
 */
type CellShape = 'empty' | 'day' | 'number' | 'text';

function cellShape(cell: string): CellShape {
  const trimmed = cell.trim();
  if (trimmed === '') return 'empty';
  if (isOversizedCell(trimmed)) return 'text';
  const dateish = trimTrailingPunctuation(trimmed);
  if (parseDay(dateish) !== null || parseGermanShortDay(dateish) !== null) return 'day';
  if (parseDecimal(trimmed) !== null || parseEnglishDecimal(trimmed) !== null) return 'number';
  return 'text';
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
      column: -1,
      message:
        `Line ${lineNumbers[index] ?? '?'} reads as a "${word}" total of the rows around it ` +
        `instead of booking a transaction — importing it would double-count that amount.`,
    });
  });
  return issues;
}

/**
 * Trim a per-row issue list to {@link MAX_ROW_ISSUES}, replacing the tail with
 * one aggregate line. The MACHINE-facing channel ({@link SniffedTable.rowFlags})
 * stays complete; only the operator-facing list is bounded, so a wholly ragged
 * file cannot emit thousands of messages while rows past the cap still carry
 * their flags.
 */
function capRowIssues(issues: TableIssue[], aggregate: (hidden: number) => string): TableIssue[] {
  if (issues.length <= MAX_ROW_ISSUES) return issues;
  const hidden = issues.length - MAX_ROW_ISSUES;
  const kept = issues.slice(0, MAX_ROW_ISSUES);
  kept.push({
    kind: issues[0]!.kind,
    line: -1,
    row: -1,
    column: -1,
    message: aggregate(hidden),
  });
  return kept;
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

/** Why a quote-aware read had to be abandoned — each says something DIFFERENT. */
type RecordSplitFailure =
  /** A field opened with `"` and the file ended before it closed. */
  | 'unterminated-quote'
  /** A quoted field is still open after {@link MAX_RECORD_LINES} physical lines. */
  | 'record-too-long'
  /** A field's closing `"` is followed by more text instead of a separator. */
  | 'quote-not-at-field-end';

interface RecordSplitResult {
  /** The records, or null when the quoting could not be trusted. */
  records: RawRecord[] | null;
  /** Set exactly when `records` is null; `line` points at the culprit. */
  failure: { reason: RecordSplitFailure; line: number } | null;
}

/**
 * Split the text into RECORDS, treating a newline inside an open quote as part
 * of the field rather than a record boundary.
 *
 * Splitting on newlines before any quote tracking is what broke IBKR-style
 * exports with embedded newlines in a description: a quoted two-line
 * description produced a TRUNCATED row (its amount gone) plus a phantom row
 * whose first cell was the tail of the description — with `issues: []`.
 *
 * The scan is RFC-4180, not a quote counter. Counting quotes per line and
 * flipping state on an odd count destroyed data outright: a stray inch-mark
 * (`27" Monitor`) is an odd line, so TWO of them within {@link MAX_RECORD_LINES}
 * merged their two physical rows into ONE record — which still had the header's
 * cell count, so the row-width check never fired. The first booking took the
 * second one's amount, the second booking disappeared, and the file reported
 * `issues: []` at 0.95 confidence. An EVEN number of such lines silently halved
 * the data every time. A `"` now opens a field only at FIELD START (the same
 * rule `csv.splitCells` applies, so the two agree by construction), which makes
 * an inch-mark an ordinary character and leaves the rows untouched.
 *
 * Three failure modes make the quote-aware reading unusable, and each returns
 * its own reason rather than a worse table: an unterminated quote, a record
 * past the line bound, and a closing quote with text after it (the malformed
 * shape a stray FIELD-START quote produces). The caller then falls back to the
 * physical-line reading with an `unbalanced-quote` issue whose message says
 * which of the three actually happened — the single message this used to emit
 * told an operator with a long legitimate description that "the quote
 * characters in this file do not pair up", which was simply false.
 *
 * `delimiter` is null on the FIRST pass, where any of the three candidate
 * separators counts as a field boundary. That pass exists because the delimiter
 * is sniffed from records and records need the delimiter: sniffing a
 * provisional delimiter from PHYSICAL lines instead reads a file whose quoted
 * description spans ten lines as ten one-column rows and then picks a separator
 * that appears nowhere. The candidate-set reading can only ever MERGE lines
 * that the true delimiter would not, and a wrong merge changes the record's
 * width, so it surfaces as `row-width-mismatch` rather than silently. Once the
 * delimiter is known the caller runs this again WITH it, so the final record
 * boundaries and `csv.splitCells` agree exactly.
 */
function splitQuotedRecords(physicalLines: string[], delimiter: string | null): RecordSplitResult {
  const isBoundary = (ch: string): boolean =>
    delimiter === null ? (DELIMITERS as readonly string[]).includes(ch) : ch === delimiter;
  const records: RawRecord[] = [];
  const fail = (reason: RecordSplitFailure, line: number): RecordSplitResult => ({
    records: null,
    failure: { reason, line },
  });
  let pending: string[] = [];
  let startLine = 1;
  let inQuotes = false;
  // Nothing but padding has been seen since the current field began.
  let fieldStart = true;
  // Where the currently OPEN quoted field started, for the failure message.
  let quoteOpenedOn = -1;

  for (let i = 0; i < physicalLines.length; i++) {
    const line = physicalLines[i] ?? '';
    if (pending.length === 0) startLine = i + 1;
    pending.push(line);
    if (pending.length > MAX_RECORD_LINES) {
      return fail('record-too-long', quoteOpenedOn > 0 ? quoteOpenedOn : startLine);
    }
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (inQuotes) {
        if (ch !== '"') continue;
        if (line[j + 1] === '"') {
          j += 1; // an escaped `""` — still inside the field
          continue;
        }
        // RFC-4180: a closing quote is followed by the delimiter or by the end
        // of the line. Anything else means the quoting is not what it looks
        // like, and guessing at the field boundaries is how data moves rows.
        const next = line[j + 1];
        if (next !== undefined && !isBoundary(next)) {
          return fail('quote-not-at-field-end', quoteOpenedOn > 0 ? quoteOpenedOn : i + 1);
        }
        inQuotes = false;
        fieldStart = false;
        continue;
      }
      if (ch === '"' && fieldStart) {
        inQuotes = true;
        fieldStart = false;
        quoteOpenedOn = i + 1;
        continue;
      }
      if (isBoundary(ch)) fieldStart = true;
      else if (!isFieldPadding(ch)) fieldStart = false;
    }
    // Still inside a quoted field ⇒ the record continues on the next line.
    if (inQuotes) continue;
    records.push({ line: startLine, raw: pending.join('\n') });
    pending = [];
    fieldStart = true;
  }
  if (inQuotes || pending.length > 0) {
    return fail('unterminated-quote', quoteOpenedOn > 0 ? quoteOpenedOn : startLine);
  }
  return { records, failure: null };
}

/** The operator-facing text for each way the quote-aware read can fail (S7). */
function quoteFailureMessage(reason: RecordSplitFailure, line: number): string {
  const fallback =
    'Each line was read on its own instead — check that no description was cut short before ' +
    'importing.';
  switch (reason) {
    case 'record-too-long':
      return (
        `A quoted field starting on line ${line} is still open ${MAX_RECORD_LINES} lines later, ` +
        `which is longer than any real description. ${fallback}`
      );
    case 'quote-not-at-field-end':
      return (
        `A quoted field starting on line ${line} has a closing quote with more text after it ` +
        `instead of a column separator, so its cell boundaries cannot be trusted. ${fallback}`
      );
    case 'unterminated-quote':
    default:
      return (
        `A quoted field starting on line ${line} is never closed — the quote characters in this ` +
        `file do not pair up, so a quoted field may not end where it looks like it does. ` +
        `${fallback}`
      );
  }
}

// --- The CSV front-end -------------------------------------------------------

function sniffCsvTable(text: string, options: SniffOptions): SniffedTable | null {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const physicalLines = clean.split(/\r\n|\r|\n/);
  const nonBlank = (raw: string): boolean => raw.trim() !== '';

  // Records need the delimiter (a `"` opens a field only right after ONE) and
  // the delimiter is sniffed from records, so this runs in two passes. The
  // first is delimiter-AGNOSTIC — any candidate separator counts as a field
  // boundary — purely to assemble the records the sniff is scored on; the
  // second re-splits with the answer so the final boundaries and
  // `csv.splitCells` cannot disagree. Deterministic and bounded at two passes.
  const physical = (): RawRecord[] => physicalLines.map((raw, i) => ({ line: i + 1, raw }));
  const firstPass = splitQuotedRecords(physicalLines, null);
  const sniffFrom = (firstPass.records ?? physical()).map((r) => r.raw).filter(nonBlank);
  if (sniffFrom.length === 0) return null;
  const delimiter = sniffTableDelimiter(sniffFrom);

  // The first pass owns the verdict on whether the quoting is trustworthy at
  // all; only when it is does the second pass get to refine the boundaries.
  const quoted = firstPass.records ? splitQuotedRecords(physicalLines, delimiter) : firstPass;
  const allRecords: RawRecord[] = quoted.records ?? physical();

  // Non-blank records keep their physical numbering; blank separators are skipped.
  const lines = allRecords.filter(({ raw }) => nonBlank(raw));
  if (lines.length === 0) return null;

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
  if (quoted.failure) {
    issues.push({
      kind: 'unbalanced-quote',
      line: quoted.failure.line,
      row: -1,
      column: -1,
      message: quoteFailureMessage(quoted.failure.reason, quoted.failure.line),
    });
  }
  const oversizedLines = split.filter(
    ({ raw, cells }) => raw.length > MAX_LINE_CHARS || cells.some(isOversizedCell),
  );
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
        column: -1,
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
        column: -1,
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

  // Row-level findings are collected COMPLETE here and only the operator-facing
  // `issues` list is capped afterwards — see RowFlag.
  const rowFlags = new Map<number, Set<TableIssueKind>>();
  const flagRow = (row: number, kind: TableIssueKind): void => {
    if (!ROW_FLAG_KINDS.has(kind)) return;
    const set = rowFlags.get(row);
    if (set) set.add(kind);
    else rowFlags.set(row, new Set([kind]));
  };

  issues.push(...raggedRowIssues(rows, lineNumbers, headers, header !== undefined, flagRow));

  const samples = sampleCells(rows);
  const { locale: dateLocale, ambiguous, twoDigitYear } = detectDateLocale(samples);
  const numberLocale = detectNumberLocale(samples, dateLocale);
  if (ambiguous) {
    issues.push({
      kind: 'ambiguous-date-locale',
      line: header?.line ?? -1,
      row: -1,
      column: -1,
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
      column: -1,
      message:
        'This file writes dates with a two-digit year (e.g. 15.01.24), so the century is not in ' +
        'the data. The century was inferred so that no date lands in the future — confirm the ' +
        'years before importing.',
    });
  }
  issues.push(...ambiguousNumberIssues(rows, lineNumbers, headers, numberLocale, flagRow));

  const summaries = detectSummaryRows(rows, lineNumbers);
  for (const issue of summaries) flagRow(issue.row, 'summary-row');
  issues.push(
    ...capRowIssues(
      summaries,
      (hidden) => `${hidden} further row(s) also read as a total rather than a booking.`,
    ),
  );

  if (oversizedLines.length > 0) {
    const oversizedRows = rows
      .map((cells, index) => ({ cells, index }))
      .filter(({ cells }) => cells.some(isOversizedCell));
    for (const { index } of oversizedRows) flagRow(index, 'oversized-cell');
    issues.push({
      kind: 'oversized-cell',
      line: oversizedLines[0]!.line,
      row: oversizedRows[0]?.index ?? -1,
      column: -1,
      message:
        `Line ${oversizedLines[0]!.line} carries a field longer than ${MAX_CELL_CHARS} characters ` +
        `(${oversizedLines.length} line(s) affected). Those fields were kept as-is but not ` +
        `interpreted as dates, amounts or identifiers — check them before importing.`,
    });
  }

  return {
    delimiter,
    encoding: 'utf-8',
    headerRowIndex: header?.line ?? -1,
    headers,
    rows,
    lineNumbers,
    dateLocale,
    dateLocaleAmbiguous: ambiguous,
    numberLocale,
    defaultCurrency: detectDefaultCurrency(samples),
    issues,
    rowFlags: [...rowFlags.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, flags]) => ({
        row,
        line: lineNumbers[row] ?? -1,
        flags: [...flags].sort(),
      })),
  };
}

/** How many full-width rows are sampled to learn a column's value shape (S4). */
const SHAPE_SAMPLE_ROWS = 200;

/**
 * Report data rows whose width does not match the header's, splitting the LOUD
 * misalignment from the harmless raggedness (S4 ruling).
 *
 * A row WIDER than the header, or a short row whose values do not line up under
 * labels of the right kind, is `row-width-mismatch`: which cell belongs to which
 * label is unknowable, and a 3-cell row under a 5-cell header once handed the
 * wizard `{quantity: '-80,00'}` — the AMOUNT booked as a quantity of -80
 * shares — with `issues: []`. Those rows are kept verbatim and reported loudly;
 * padding them would just be a different silent guess. (The repo's own
 * `ibkr.csv` has six genuinely misaligned rows and every one of them still lands
 * here.)
 *
 * A row that is merely SHORT gets the quieter `trailing-cells-omitted` kind when
 * the file itself proves the omission is ordinary, which takes two independent
 * pieces of evidence:
 *  1. every missing trailing column is one the file leaves EMPTY in at least one
 *     of its full-width rows — the column is optional in this export, and
 *  2. every value the row does carry has the same coarse shape as its column has
 *     in the full-width rows — nothing slid left into the wrong label.
 * Both must hold. Requiring (1) is what keeps the measured `-80,00` case loud:
 * in that file the trailing Kurs/Betrag columns are never empty, so its short
 * row is not an omission at all.
 */
function raggedRowIssues(
  rows: string[][],
  lineNumbers: number[],
  headers: string[],
  hasHeader: boolean,
  flagRow: (row: number, kind: TableIssueKind) => void,
): TableIssue[] {
  if (!hasHeader) return [];
  const width = headers.length;
  const offenders = rows
    .map((cells, index) => ({ cells, index }))
    .filter(({ cells }) => cells.length !== width);
  if (offenders.length === 0) return [];

  const fullWidth = rows.filter((cells) => cells.length === width);
  // Emptiness is a trim test — cheap enough to look at every full-width row.
  const optional = Array.from({ length: width }, (_unused, column) =>
    fullWidth.some((cells) => (cells[column] ?? '').trim() === ''),
  );
  // Shape needs real parsing, so it samples (a sampling contract, like sampleCells).
  const shapeSample = fullWidth.slice(0, SHAPE_SAMPLE_ROWS);
  const columnShape = Array.from({ length: width }, (_unused, column) => {
    const freq = new Map<CellShape, number>();
    for (const cells of shapeSample) {
      const shape = cellShape(cells[column] ?? '');
      if (shape === 'empty') continue;
      freq.set(shape, (freq.get(shape) ?? 0) + 1);
    }
    let best: CellShape | null = null;
    let bestCount = 0;
    for (const [shape, count] of freq) {
      if (count > bestCount) {
        best = shape;
        bestCount = count;
      }
    }
    return best;
  });

  const aligns = (cells: string[]): boolean =>
    cells.every((cell, column) => {
      const expected = columnShape[column];
      if (expected === null || expected === undefined) return true;
      const shape = cellShape(cell);
      return shape === 'empty' || shape === expected;
    });
  const isTrailingOmission = (cells: string[]): boolean => {
    if (cells.length >= width) return false;
    for (let column = cells.length; column < width; column++) {
      if (!optional[column]) return false;
    }
    return aligns(cells);
  };

  const loud: TableIssue[] = [];
  const quiet: TableIssue[] = [];
  for (const { cells, index } of offenders) {
    const line = lineNumbers[index] ?? -1;
    if (isTrailingOmission(cells)) {
      quiet.push({
        kind: 'trailing-cells-omitted',
        line,
        row: index,
        column: -1,
        message:
          `Line ${line} stops after ${cells.length} of ${width} column(s). The columns it leaves ` +
          `out are ones this file leaves empty elsewhere and every value it does carry lines up ` +
          `under the right label, so it was read as written.`,
      });
      continue;
    }
    flagRow(index, 'row-width-mismatch');
    loud.push({
      kind: 'row-width-mismatch',
      line,
      row: index,
      column: -1,
      message:
        `Line ${line} has ${cells.length} column(s) but the header has ${width} — its values ` +
        `cannot be matched to labels reliably (an amount can land in a quantity). Check this ` +
        `row before importing.`,
    });
  }
  return [
    ...capRowIssues(
      loud,
      (hidden) => `${hidden} further row(s) also differ from the header's ${width} column(s).`,
    ),
    ...capRowIssues(
      quiet,
      (hidden) => `${hidden} further row(s) also stop short of the header's ${width} column(s).`,
    ),
  ];
}

/**
 * Report columns carrying grouped numbers the file's notation cannot read (S3).
 *
 * One issue PER COLUMN — the mapper reads `column` off it and forces
 * `needsReview` on that column, so a caller cannot end up with a confidently
 * mapped Quantity whose values are null. Every affected ROW is flagged as well,
 * uncapped, so the row classifier sees them all.
 */
function ambiguousNumberIssues(
  rows: string[][],
  lineNumbers: number[],
  headers: string[],
  locale: NumberLocale,
  flagRow: (row: number, kind: TableIssueKind) => void,
): TableIssue[] {
  // A fold, not `Math.max(...rows.map(…))`: spreading one argument per row
  // overflows the call stack on a large upload, which is a crash a hostile
  // file could buy for the price of 100k rows.
  let width = headers.length;
  for (const row of rows) if (row.length > width) width = row.length;
  const issues: TableIssue[] = [];
  for (let column = 0; column < width; column++) {
    let count = 0;
    let firstRow = -1;
    let sample = '';
    rows.forEach((cells, index) => {
      const cell = cells[column] ?? '';
      if (!isAmbiguousGroupedNumber(cell, locale)) return;
      count += 1;
      if (firstRow === -1) {
        firstRow = index;
        sample = cell.trim();
      }
      flagRow(index, 'ambiguous-grouped-number');
    });
    if (count === 0) continue;
    const label = headers[column]?.trim();
    issues.push({
      kind: 'ambiguous-grouped-number',
      line: lineNumbers[firstRow] ?? -1,
      row: firstRow,
      column,
      message:
        `Column ${label ? `"${label}"` : column + 1} has ${count} value(s) like "${sample}" whose ` +
        `grouping this file's number notation cannot resolve — "1,250" is 1250 written the ` +
        `English way and 1.25 written the German way. Those cells were NOT read as numbers ` +
        `rather than risk a value 1000× off; confirm the column before importing.`,
    });
  }
  return issues;
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
 * Under `de` the two-digit-year form (`15.01.24`) is read as well, and under the
 * slash locales so is `01/15/24`, with the century inferred by
 * {@link expandTwoDigitYear}. Refusing them outright would mean every date in
 * such a file coming back null — the failure the sniffer used to hide behind a
 * clean report — so they parse, and the file carries a `two-digit-year` issue
 * saying the century was not in the data. The `iso` locale deliberately does
 * NOT read `15.01.24`: nothing in an ISO file says its dotted dates are
 * day-first, and a loud null beats a guessed month.
 */
export function parseLocalizedDay(input: string, locale: DateLocale): Date | null {
  if (input.length > MAX_CELL_CHARS) return null;
  if (locale === 'us' || locale === 'eu-slash') {
    const trimmed = input.trim();
    const long = SLASH_DAY_SAMPLE.exec(trimmed);
    const short = long ? null : SLASH_SHORT_DAY_SAMPLE.exec(trimmed);
    const match = long ?? short;
    if (!match) return null;
    const [, first, second, rawYear] = match as unknown as [string, string, string, string];
    const y = short ? String(expandTwoDigitYear(rawYear)) : rawYear;
    const [month, day] = locale === 'us' ? [first, second] : [second, first];
    return parseDay(`${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  }
  if (locale === 'de') {
    const short = parseGermanShortDay(input);
    if (short !== null) return short;
  }
  return parseDay(input);
}
