import { stripDecimalDecoration } from '../csv';

/**
 * ENGLISH-notation amount parsing for the bank-statement mappers (PROJECTPLAN.md
 * §13.5 V5-P9).
 *
 * The framework's `parseDecimal` (`../csv`) reads a comma as the GERMAN decimal
 * separator, so an English-grouped `1,200` becomes 1.2 and `2,400.00` becomes
 * 2.4 — a booking 1000× understated, silently, with no error row. The broker
 * path already learned this the hard way (`../mappers/ibkr.ts`), and the
 * English-notation bank exports (N26, Revolut) need the same defence.
 *
 * Deliberately duplicated rather than unified with `ibkr.parseEnglishDecimal`:
 * the shared framework module and the broker mappers are owned by open import
 * work (#1568, #1537). Folding both callers onto one `parseEnglishDecimal` in
 * `../csv` is the intended follow-up once those land.
 */

/** Which decimal notation a bank's amount column is written in. */
export type AmountNotation = 'german' | 'english';

/**
 * Parse an ENGLISH-notation decimal (`1,234.56` — dot decimal, comma
 * thousands), returning null rather than a guess.
 *
 * Decoration (currency symbols/letters, spaces) is stripped by the shared
 * {@link stripDecimalDecoration}, so `-42.50 EUR` still parses and the refused
 * forms (parenthesized negatives, `1e5`) stay refused. Grouping commas must
 * then match 3-digit groups EXACTLY: `1,234` is 1234, while `1,20` or `1,2345`
 * is not English grouping at all and is refused — the mirror image of
 * `parseDecimal` refusing an ambiguous `1.234`. A refusal costs one reported
 * row; a guess misbooks money.
 */
export function parseEnglishAmount(input: string): number | null {
  const decorated = stripDecimalDecoration(input);
  if (decorated === null) return null;
  // The sign is only meaningful leading; a trailing one ("1,200-") silently
  // dropped would flip a booking's direction, so it is refused below.
  const sign = decorated.startsWith('-') ? -1 : 1;
  let cleaned = decorated.replace(/^[+-]/, '');
  if (/[+-]/.test(cleaned)) return null;
  if (cleaned.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) return null;
    cleaned = cleaned.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? sign * value : null;
}
