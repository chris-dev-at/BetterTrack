/**
 * Pure CSV parsing for broker imports (PROJECTPLAN.md §13.4 V4-P8). No I/O —
 * everything here is a deterministic function over the uploaded text, tested
 * directly. Broker exports are messy: delimiters vary (`;` for the German
 * brokers, `,` for IBKR), fields may be quoted with `""` escapes, numbers come
 * in German (`1.234,56`) or plain (`1234.56`) notation, dates in ISO or
 * `DD.MM.YYYY`. The helpers below normalize all of that; per-row *semantic*
 * validation stays in the mappers.
 */

/** One physical CSV record: its 1-based line number, raw text, and cells. */
export interface CsvRecord {
  line: number;
  raw: string;
  cells: string[];
}

/** A parsed file: the sniffed delimiter, the header record, and the data records. */
export interface ParsedCsv {
  delimiter: string;
  header: CsvRecord | null;
  records: CsvRecord[];
}

const DELIMITERS = [';', ',', '\t'] as const;

/** Count occurrences of `delim` in `line`, ignoring quoted stretches. */
function countUnquoted(line: string, delim: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delim && !inQuotes) count++;
  }
  return count;
}

/** Pick the delimiter that splits the header line most often (`;` > `,` > tab on ties). */
export function sniffDelimiter(headerLine: string): string {
  let best: string = DELIMITERS[0];
  let bestCount = -1;
  for (const d of DELIMITERS) {
    const count = countUnquoted(headerLine, d);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Split one record line into cells: RFC-4180 quotes with `""` escapes, trimmed. */
export function splitCells(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Parse an uploaded CSV into header + data records. The first non-empty line is
 * the header (broker exports always ship one); blank lines are skipped but line
 * numbers stay physical (1-based), so a preview row points at the real line in
 * the user's file. Embedded newlines inside quoted fields are NOT supported —
 * no supported broker emits them, and one record per physical line keeps the
 * raw-line audit trail exact.
 */
export function parseCsv(text: string): ParsedCsv {
  // Strip a UTF-8 BOM (Excel-produced exports often carry one).
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r\n|\r|\n/);

  let header: CsvRecord | null = null;
  let delimiter: string = DELIMITERS[0];
  const records: CsvRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    if (!header) {
      delimiter = sniffDelimiter(raw);
      header = { line: i + 1, raw, cells: splitCells(raw, delimiter) };
      continue;
    }
    records.push({ line: i + 1, raw, cells: splitCells(raw, delimiter) });
  }

  return { delimiter, header, records };
}

/**
 * Parse a broker-notation decimal. Handles German (`1.234,56` — comma decimal,
 * dot/space thousands) and plain (`1234.56`) notation in one pass: when a comma
 * is present it is the decimal separator and dots/spaces are grouping; without
 * one, a dot is the decimal separator. Currency letters/symbols and sign
 * prefixes survive (`-751,00 EUR` → -751). Returns null when nothing numeric
 * remains — or when the notation is AMBIGUOUS: `1.000` with no decimal comma is
 * German grouping (1000) or a plain decimal (1.0), and guessing wrong books a
 * quantity ~1000× off. Refusing costs one reported row; guessing costs money.
 */
export function parseDecimal(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  // Keep digits, separators and the leading sign; drop currency symbols/letters.
  let cleaned = trimmed.replace(/[^0-9.,\-+]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;
  const sign = cleaned.startsWith('-') ? -1 : 1;
  cleaned = cleaned.replace(/[+-]/g, '');
  if (cleaned.includes(',')) {
    // German notation: dots are thousands grouping, the comma is the decimal.
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    // Grouping-dot integer without a decimal comma — ambiguous, see above.
    return null;
  }
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? sign * value : null;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const GERMAN_DAY = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

/**
 * Parse an ISO (`2024-01-15`) or German (`15.01.2024`) calendar day — a leading
 * date-time is accepted, the time portion is ignored (broker exports carry at
 * most a day). Returns the day anchored at **12:00 UTC**, so the calendar day
 * survives display in any European timezone and the Vienna tax-year derivation
 * (§13.3 V3-P4). Null when not a valid calendar date.
 */
export function parseDay(input: string): Date | null {
  const token = input.trim().split(/[T\s]/)[0] ?? '';
  let year: number, month: number, day: number;
  const iso = ISO_DAY.exec(token);
  const german = GERMAN_DAY.exec(token);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (german) {
    [year, month, day] = [Number(german[3]), Number(german[2]), Number(german[1])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  // Reject rolled-over impossibilities like 31.02. (Date.UTC silently wraps).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
