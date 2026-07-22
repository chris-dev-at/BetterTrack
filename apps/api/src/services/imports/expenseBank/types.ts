import type { ExpenseDirection } from '@bettertrack/contracts';
import { EXPENSE_AMOUNT_MAX } from '@bettertrack/contracts';

import { parseDay, parseDecimal, type CsvRecord, type ParsedCsv } from '../csv';

/**
 * The bank-statement mapper contract (PROJECTPLAN.md §13.5 V5-P9, issue 2/3). A
 * NEW mapper family, distinct from the broker mappers in `../mappers/**` (those
 * map securities trades; these map a bank account's spend/income rows into
 * EXPENSE transactions) — it has its own registry so broker autodetect is
 * untouched. Adding a bank is exactly one mapper module (+ one anonymized
 * fixture) registered in `index.ts`; the framework never changes per bank.
 *
 * Mappers are pure: text in, normalized rows out, no I/O — so every quirk is
 * directly unit-testable. The FRAMEWORK (dedupe, auto-categorization, apply)
 * never lives in a mapper.
 */

/**
 * One bank-statement row normalized to the expense-ledger shape. A bank row is a
 * signed cash movement: `direction` is derived from the sign (`expense` out,
 * `income` in) and `amount` is the positive magnitude. `description` is the
 * merchant/memo the auto-categorization rules match against.
 */
export interface NormalizedExpenseRow {
  /** ISO `YYYY-MM-DD` booking day (the file's date, timezone-safe). */
  bookedOn: string;
  direction: ExpenseDirection;
  /** Positive magnitude in `currency`. */
  amount: number;
  /** ISO-4217 3-letter code (the row's stated currency; defaults to EUR). */
  currency: string;
  /** Non-empty merchant/memo text. */
  description: string;
}

/**
 * One mapped CSV line: either a normalized row or a per-line error (reported in
 * the preview while the rest of the file still lands — never all-or-nothing).
 */
export type MappedExpenseLine =
  | { line: number; raw: string; ok: true; row: NormalizedExpenseRow }
  | { line: number; raw: string; ok: false; error: string };

export interface BankStatementMapper {
  /** Stable mapper id / source slug (`erste_george`) — stamped as `import:<id>`. */
  id: string;
  /** Human label ("Erste / George"). */
  label: string;
  /**
   * Confidence [0..1] that this parsed CSV is this bank's export — a
   * header-column fingerprint. Autodetect picks the highest score above the
   * registry threshold; a missing signature column scores 0 (disqualified) so
   * the four Austrian/English exports never cross-detect.
   */
  detect(csv: ParsedCsv): number;
  /** Map every data record to a normalized row or a per-line error. */
  map(csv: ParsedCsv): MappedExpenseLine[];
}

// --- Shared header + row helpers (kept out of the per-bank modules) ----------

/** ISO-4217 shape. Anything else ("EURO", "EUR/USD") fails its ROW, not the batch. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Lower-cased header cells, for case-insensitive column lookup. */
export function lowerHeader(header: CsvRecord | null): string[] {
  return (header?.cells ?? []).map((c) => c.toLowerCase());
}

/** Index of `name` (case-insensitive) in the header, or -1 when absent. */
export function columnIndex(header: CsvRecord | null, name: string): number {
  return lowerHeader(header).indexOf(name.toLowerCase());
}

/** The share of `names` present in the header — the base detect() fingerprint. */
export function headerCoverage(header: CsvRecord | null, names: readonly string[]): number {
  const cells = lowerHeader(header);
  const present = names.filter((n) => cells.includes(n.toLowerCase())).length;
  return names.length === 0 ? 0 : present / names.length;
}

/** The first non-blank of `values`, trimmed — the description fallback chain. */
export function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Validate + normalize the four fields every bank row reduces to (date, signed
 * amount, currency, description) into a {@link NormalizedExpenseRow}, or a
 * per-line error. Centralized so every mapper enforces the same guards: an
 * unparseable/zero amount, an out-of-range magnitude (the `numeric(20,2)`
 * column), a bad currency or an empty description each cost only their one line.
 */
export function buildExpenseRow(input: {
  line: number;
  raw: string;
  dateRaw: string;
  amountRaw: string;
  /** Blank → EUR (the AT/DE bank exports are EUR unless a currency column says otherwise). */
  currencyRaw: string;
  description: string;
}): MappedExpenseLine {
  const fail = (error: string): MappedExpenseLine => ({
    line: input.line,
    raw: input.raw,
    ok: false,
    error,
  });

  const date = parseDay(input.dateRaw);
  if (!date) return fail(`Unparseable date "${input.dateRaw}".`);

  const amount = parseDecimal(input.amountRaw);
  if (amount === null) return fail(`Unparseable amount "${input.amountRaw}".`);
  if (amount === 0) return fail('Row amount is zero.');
  if (Math.abs(amount) >= EXPENSE_AMOUNT_MAX) {
    return fail(`Amount ${amount} is too large to import.`);
  }

  const currency = (input.currencyRaw.trim() || 'EUR').toUpperCase();
  if (!CURRENCY_PATTERN.test(currency))
    return fail(`Unrecognized currency "${input.currencyRaw}".`);

  const description = input.description.trim();
  if (!description) return fail('Row has no description.');

  return {
    line: input.line,
    raw: input.raw,
    ok: true,
    row: {
      bookedOn: date.toISOString().slice(0, 10),
      direction: amount < 0 ? 'expense' : 'income',
      amount: Math.abs(amount),
      currency,
      description,
    },
  };
}
