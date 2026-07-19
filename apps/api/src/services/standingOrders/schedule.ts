import type { StandingOrderCadence } from '@bettertrack/contracts';

/**
 * Pure scheduling math for standing orders (issue #593). Everything here speaks
 * in ISO `YYYY-MM-DD` calendar days (which sort lexicographically = chronologic-
 * ally), so the whole due-computation is a deterministic, timezone-free, fully
 * unit-testable function of (schedule spec, today). The single time-dependent
 * hop — mapping a wall-clock instant to "today" in the deploy timezone — is
 * isolated in {@link calendarDayInTimezone}.
 *
 * Two planner rules (§16, issue #593) live here:
 *  1. **Most-recent-only catch-up.** {@link dueOccurrence} returns the single
 *     most recent scheduled occurrence on or before today — never a backlog. So
 *     after downtime of N periods only the newest is booked; the rest are
 *     skipped (the job logs them).
 *  2. **Monthly clamps to month-end.** A monthly order anchored on day 31 fires
 *     on Feb 28/29, Apr 30, … — {@link clampDay} caps the anchor at the month's
 *     real length.
 */

/** A standing order's schedule, distilled to what the math needs. */
export interface ScheduleSpec {
  cadence: StandingOrderCadence;
  /** 1–31 for `monthly`; ignored (null) for `daily`. */
  anchorDay: number | null;
  /** Inclusive ISO `YYYY-MM-DD` first day the order may fire. */
  startDate: string;
  /** Inclusive ISO `YYYY-MM-DD` last day it may fire, or null for open-ended. */
  endDate: string | null;
}

interface DayParts {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Real length of a 1-based month, leap-year aware. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** The anchor day clamped to the month's real end (day 31 → Feb 28/29, …). */
export function clampDay(year: number, month: number, anchorDay: number): number {
  return Math.min(anchorDay, daysInMonth(year, month));
}

function parseDay(iso: string): DayParts {
  const [year, month, day] = iso.split('-').map((p) => Number.parseInt(p, 10));
  return { year: year!, month: month!, day: day! };
}

function formatDay(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** The month before `{year, month}` (1-based), rolling the year at January. */
function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** The month after `{year, month}` (1-based), rolling the year at December. */
function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** The clamped monthly occurrence date within one month. */
function monthlyOccurrence(year: number, month: number, anchorDay: number): string {
  return formatDay(year, month, clampDay(year, month, anchorDay));
}

/**
 * The most recent occurrence on or before `today`, ignoring start/end bounds.
 * Daily → `today` itself; monthly → this month's clamped anchor if it has
 * already arrived, else last month's.
 */
function mostRecentOnOrBefore(spec: ScheduleSpec, today: string): string {
  if (spec.cadence === 'daily') return today;
  const { year, month } = parseDay(today);
  const thisMonth = monthlyOccurrence(year, month, spec.anchorDay!);
  if (thisMonth <= today) return thisMonth;
  const prev = prevMonth(year, month);
  return monthlyOccurrence(prev.year, prev.month, spec.anchorDay!);
}

/**
 * The first occurrence strictly after `ref`, ignoring start/end bounds. Daily →
 * the following calendar day; monthly → this month's clamped anchor if still
 * ahead of `ref`, else next month's.
 */
function firstAfter(spec: ScheduleSpec, ref: string): string {
  const { year, month, day } = parseDay(ref);
  if (spec.cadence === 'daily') {
    const dim = daysInMonth(year, month);
    if (day < dim) return formatDay(year, month, day + 1);
    const next = nextMonth(year, month);
    return formatDay(next.year, next.month, 1);
  }
  const thisMonth = monthlyOccurrence(year, month, spec.anchorDay!);
  if (thisMonth > ref) return thisMonth;
  const next = nextMonth(year, month);
  return monthlyOccurrence(next.year, next.month, spec.anchorDay!);
}

/**
 * The single occurrence that is due to fire as of `today`: the most recent
 * scheduled occurrence within `[startDate, min(today, endDate)]`, or null when
 * the order has not started yet (or its whole schedule sits past `today` with
 * nothing in range). Capping at `endDate` is what "reaching the end date stops
 * the order" means — no occurrence after the end is ever returned, and once the
 * final in-range occurrence is booked the caller's per-period claim keeps it
 * from re-firing.
 */
export function dueOccurrence(spec: ScheduleSpec, today: string): string | null {
  // Never look past the end date: cap the horizon there when today is beyond it.
  const horizon = spec.endDate !== null && spec.endDate < today ? spec.endDate : today;
  if (horizon < spec.startDate) return null;
  const occ = mostRecentOnOrBefore(spec, horizon);
  return occ >= spec.startDate ? occ : null;
}

/**
 * The next calendar day this order will fire as of `today`, for display
 * (`nextRunDate`). An unbooked due occurrence (overdue, will fire on the next
 * job run) is surfaced as-is; otherwise the next occurrence strictly after
 * today, capped by the end date (null once the schedule is exhausted). `paused`
 * orders never have a next run.
 */
export function nextRunDate(
  spec: ScheduleSpec,
  today: string,
  lastPeriodKey: string | null,
  active: boolean,
): string | null {
  if (!active) return null;
  const due = dueOccurrence(spec, today);
  // A due occurrence not yet booked fires on the next run — surface it directly.
  if (due !== null && (lastPeriodKey === null || lastPeriodKey < due)) return due;
  const start = today < spec.startDate ? prevDay(spec.startDate) : today;
  const next = firstAfter(spec, start);
  if (spec.endDate !== null && next > spec.endDate) return null;
  return next;
}

/** The calendar day before `iso` (used to include `startDate` itself in a scan). */
function prevDay(iso: string): string {
  const { year, month, day } = parseDay(iso);
  if (day > 1) return formatDay(year, month, day - 1);
  const prev = prevMonth(year, month);
  return formatDay(prev.year, prev.month, daysInMonth(prev.year, prev.month));
}

/**
 * How many scheduled occurrences fall strictly between `afterExclusive` and
 * `throughInclusive` — the periods a catch-up skipped (for the job log; never
 * booked). `afterExclusive` null means "since the beginning", counted from the
 * start date. Bounded so a pathological span can never loop unbounded.
 */
export function skippedPeriodCount(
  spec: ScheduleSpec,
  afterExclusive: string | null,
  throughInclusive: string,
  cap = 400,
): number {
  const lower = afterExclusive !== null && afterExclusive >= spec.startDate ? afterExclusive : null;
  let cursor = lower === null ? prevDay(spec.startDate) : lower;
  let count = 0;
  while (count <= cap) {
    const next = firstAfter(spec, cursor);
    if (next >= throughInclusive) break;
    cursor = next;
    count += 1;
  }
  return count;
}

/**
 * The calendar day (ISO `YYYY-MM-DD`) a wall-clock instant falls on in a given
 * IANA timezone — the one place the schedule touches real time. `en-CA` renders
 * exactly `YYYY-MM-DD`.
 */
export function calendarDayInTimezone(nowMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}
