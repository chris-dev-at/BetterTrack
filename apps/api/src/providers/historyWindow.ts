import type { HistoryRange } from '@bettertrack/contracts';

/**
 * Maps a §5.3 range preset to the start of its lookback window. Both the Yahoo
 * provider (to derive `chart()`'s `period1`) and the manual provider (to clamp
 * + carry forward value points) share this so a "1Y" means the same span
 * everywhere. Spans are deliberately a touch generous — over-including a day at
 * the left edge is harmless (upstream clamps to what it has; the manual carry-
 * forward fills the gap), under-including would silently drop data.
 */
const LOOKBACK_DAYS: Record<Exclude<HistoryRange, 'MAX'>, number> = {
  '1D': 1,
  '1W': 7,
  '1M': 31,
  '3M': 93,
  '6M': 186,
  '1Y': 366,
  '5Y': 1830,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Epoch-ms start of the window for `range`, measured back from `endMs`. `MAX`
 * returns the Unix epoch (0) — early enough to cover any real asset history
 * while staying a valid date for `new Date(...)`.
 */
export function rangeStartMs(endMs: number, range: HistoryRange): number {
  if (range === 'MAX') return 0;
  return endMs - LOOKBACK_DAYS[range] * DAY_MS;
}
