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
