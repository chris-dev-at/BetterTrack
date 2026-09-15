import { calendarDayInTimezone } from '../standingOrders/schedule';

/**
 * The one day boundary the V5-P5 roll-ups compare "upcoming vs past" against.
 *
 * Every date these responses carry is RENDERED in the display zone (§7.1: dates
 * display in Vienna wall clock under the active locale, `apps/web/src/lib/format.ts`),
 * so the day they are filtered on has to be that same zone's day. Taken on the
 * UTC day instead (the shape until #1827), the boundary lagged by up to two
 * hours every night: between 00:00 and 02:00 Vienna the UTC day is still
 * yesterday, so a payout that went ex yesterday was served — and rendered —
 * under "Upcoming". Server-side twin of `displayZoneDay()` on the client.
 *
 * The scan jobs deliberately do NOT use this: their crons are 06:00/06:30 local,
 * where the two days coincide, and their windows are anchored on the job clock.
 */
export const MARKET_INTEL_DISPLAY_TIME_ZONE = 'Europe/Vienna';

/** The calendar day (`YYYY-MM-DD`) an instant falls on in the display zone. */
export function marketIntelDisplayDay(nowMs: number): string {
  return calendarDayInTimezone(nowMs, MARKET_INTEL_DISPLAY_TIME_ZONE);
}

/**
 * The day an EVENT's timestamp falls on in the display zone — the other side of
 * every comparison {@link marketIntelDisplayDay} supplies the boundary for.
 *
 * #1827 moved the boundary to Vienna and left the event side as the UTC date
 * substring, which is a different day for any stamp after 22:00 UTC (23:00 in
 * winter). An APAC issuer's `2026-09-05T23:30:00.000Z` report renders as
 * 06.09.2026 (`formatDate`, §7.1) and was therefore shown dated the 6th on the
 * 5th — and dropped on the 6th, the very day the reader's calendar said it
 * happened, because `'2026-09-05' < '2026-09-06'`. Both sides have to be the day
 * the date is RENDERED in.
 *
 * Null for a stamp that cannot be parsed, so a caller decides what an undated
 * event means rather than inheriting a silently wrong day.
 */
export function marketIntelEventDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return calendarDayInTimezone(at, MARKET_INTEL_DISPLAY_TIME_ZONE);
}
