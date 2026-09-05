import type { DividendEvent } from '@bettertrack/contracts';

/**
 * The date a dividend event is *upcoming* on, shared by every surface that
 * renders one (§13.5 V5-P5 arc a).
 *
 * The API deliberately keeps an event that has already gone ex but is not yet
 * paid — it is still upcoming until the money lands — and orders the calendar on
 * the earliest of its dates that has NOT passed
 * (`services/marketIntel/portfolioMarketIntelService.ts`, `eventSortKey`). The
 * renderers used to prefer `exDate` whenever it was non-null, which inverted
 * that ordering and printed a date already behind us under "Upcoming dividends"
 * (#1758). This module is the one copy of the server's rule, so the label, the
 * date and any client-side ordering all agree with the payload's own order.
 *
 * Days are compared as UTC day strings, exactly like the server.
 */

export interface UpcomingDividendDate {
  /** The full ISO timestamp to format — never a day the user has already lived. */
  iso: string;
  /** True when `iso` is the ex-date, false when it is the pay date. */
  isEx: boolean;
}

/** The UTC day of an instant (`YYYY-MM-DD`), the server's `todayStart` unit. */
export function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The date to render for one event: the earliest of its ex/pay dates that has
 * not yet passed. `null` when both are missing or both are behind us — an event
 * with no upcoming date is not "upcoming" and the caller drops the row.
 *
 * A same-day tie prefers the ex-date, which is the one that expires first.
 */
export function upcomingDividendDate(
  event: Pick<DividendEvent, 'exDate' | 'payDate'>,
  todayStart: string = utcDay(),
): UpcomingDividendDate | null {
  let best: UpcomingDividendDate | null = null;
  // Ex first so a same-day tie keeps the ex label (strictly-earlier wins below).
  for (const candidate of [
    { iso: event.exDate, isEx: true },
    { iso: event.payDate, isEx: false },
  ]) {
    const { iso } = candidate;
    if (iso === null) continue;
    const day = iso.slice(0, 10);
    if (day < todayStart) continue;
    if (best === null || day < best.iso.slice(0, 10)) best = { iso, isEx: candidate.isEx };
  }
  return best;
}

/**
 * The next upcoming event of an asset's dividend payload. The provider ships
 * `upcoming` in no guaranteed order, so pick the one whose upcoming day comes
 * first rather than trusting `upcoming[0]`; events entirely in the past are not
 * candidates.
 */
export function nextUpcomingDividend<T extends Pick<DividendEvent, 'exDate' | 'payDate'>>(
  upcoming: readonly T[],
  todayStart: string = utcDay(),
): T | null {
  let best: { event: T; day: string } | null = null;
  for (const event of upcoming) {
    const date = upcomingDividendDate(event, todayStart);
    if (date === null) continue;
    const day = date.iso.slice(0, 10);
    if (best === null || day < best.day) best = { event, day };
  }
  return best?.event ?? null;
}
