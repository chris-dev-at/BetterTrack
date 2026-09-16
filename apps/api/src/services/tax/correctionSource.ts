import { SOURCE_TAG_MANUAL } from '@bettertrack/contracts';

import { viennaYearOfDate } from './livingYear';

/**
 * Which source tag a DERIVED tax correction carries (V5-P0c, issue #1658).
 *
 * A `tax_withholding` / `tax_refund` correction is nothing anybody typed: it is
 * the consequence of the rows that shaped the tax year. It therefore carries the
 * source of the write that caused it — the same rule the batch path already
 * applies ("Batch year-correction legs carry the same source as the batch",
 * `portfolioService`) and the dividend path applies in
 * `taxRepository.insertDividend`. Before #1658 the correction builders passed no
 * `source` at all, so the column default stamped `manual` and a 100 %-imported
 * portfolio answered `?source=manual` with rows its owner never entered.
 *
 * On the two paths that have ONE causing write — a transaction delete, a
 * dividend delete/create — the caller simply passes that row's tag. The read-path
 * self-heal (`reconcileLiveYears`) and the vault replay have no single causing
 * write, so the cause is the tax year itself, and this is the rule:
 *
 * > When every transaction and dividend dated into that Vienna tax year carries
 * > the same tag, the correction inherits it. A year whose rows disagree — or
 * > that has no rows left at all — falls back to `manual`.
 *
 * `manual` is the deliberate fallback rather than an invented "mixed" value: the
 * tag vocabulary is fixed (§6.8.2) and #1658 puts widening it out of scope. It
 * is also the conservative direction — a mixed year is one the user did put a
 * hand into, so the fallback never claims a broker or a provider produced
 * something it did not.
 *
 * Only rows are consulted, never the year's already-posted corrections: a
 * correction is caused by rows, and reading other corrections back in would let
 * one mis-tagged legacy leg propagate its tag to every future top-up.
 */
export function correctionSourceForYear(
  year: number,
  transactions: readonly { executedAt: Date; source: string }[],
  dividendRows: readonly { executedAt: Date; source: string }[],
): string {
  let attributed: string | null = null;
  for (const row of [...transactions, ...dividendRows]) {
    if (viennaYearOfDate(row.executedAt) !== year) continue;
    if (attributed === null) attributed = row.source;
    else if (attributed !== row.source) return SOURCE_TAG_MANUAL;
  }
  return attributed ?? SOURCE_TAG_MANUAL;
}
