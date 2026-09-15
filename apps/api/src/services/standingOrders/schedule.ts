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
 * The monthly anchor, proven present. A monthly schedule without one has no
 * occurrence to point at: reading it as `Math.min(undefined, 31)` yielded NaN
 * and rendered the string `YYYY-MM-NaN` into `nextRunDate` (and, on the restore
 * path, into a claimed period key). {@link assertSchedule} already refuses that
 * row; this is the second lock on the same door, so no caller can reach the
 * math around it.
 */
function requireAnchorDay(spec: ScheduleSpec): number {
  if (spec.anchorDay === null) {
    throw new RangeError('Standing-order cadence and anchorDay are inconsistent.');
  }
  return spec.anchorDay;
}

/**
 * The most recent occurrence on or before `today`, ignoring start/end bounds.
 * Daily → `today` itself; monthly → this month's clamped anchor if it has
 * already arrived, else last month's.
 */
function mostRecentOnOrBefore(spec: ScheduleSpec, today: string): string {
  if (spec.cadence === 'daily') return today;
  const anchorDay = requireAnchorDay(spec);
  const { year, month } = parseDay(today);
  const thisMonth = monthlyOccurrence(year, month, anchorDay);
  if (thisMonth <= today) return thisMonth;
  const prev = prevMonth(year, month);
  return monthlyOccurrence(prev.year, prev.month, anchorDay);
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
  const anchorDay = requireAnchorDay(spec);
  const thisMonth = monthlyOccurrence(year, month, anchorDay);
  if (thisMonth > ref) return thisMonth;
  const next = nextMonth(year, month);
  return monthlyOccurrence(next.year, next.month, anchorDay);
}

/**
 * Whether `value` is a real ISO calendar day — the shape every comparison here
 * assumes. `2026-02-30` sorts and formats like a day but is not one.
 */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { year, month, day } = parseDay(value);
  return (
    Number.isInteger(year) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    formatDay(year, month, day) === value
  );
}

/**
 * Refuse a schedule this math cannot honestly speak for — the twin of the vault
 * engine's `assertSchedule`
 * (`apps/web/src/user/vault/standingOrders/schedule.ts`), enforcing exactly what
 * the create contract enforces on the way in: real calendar days (including any
 * watermark day passed in `days`), an end date on or after the start, and an
 * anchor present for `monthly` / absent for `daily`.
 *
 * It throws rather than guessing, because every alternative is worse for money:
 * a `2026-02-30` watermark compared lexicographically decides which periods are
 * owed, and a missing monthly anchor used to compute a `NaN` day. Callers that
 * merely display (`toDto`) catch this and show "nothing scheduled"; the scan
 * isolates it per order, so one corrupt row is reported instead of silently
 * booking or silently dropping.
 */
export function assertSchedule(spec: ScheduleSpec, ...days: readonly (string | null)[]): void {
  for (const day of [...days, spec.startDate, spec.endDate]) {
    if (day !== null && !isCalendarDay(day)) {
      throw new RangeError(`Standing-order schedule day ${day} is not a real ISO calendar day.`);
    }
  }
  if (spec.endDate !== null && spec.endDate < spec.startDate) {
    throw new RangeError('Standing-order endDate precedes startDate.');
  }
  if (
    (spec.cadence === 'daily' && spec.anchorDay !== null) ||
    (spec.cadence === 'monthly' &&
      (spec.anchorDay === null ||
        !Number.isInteger(spec.anchorDay) ||
        spec.anchorDay < 1 ||
        spec.anchorDay > 31))
  ) {
    throw new RangeError('Standing-order cadence and anchorDay are inconsistent.');
  }
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
  assertSchedule(spec, today);
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
  // The watermark decides which occurrence is still owed, so it is held to the
  // same calendar-day standard as the schedule itself.
  assertSchedule(spec, today, lastPeriodKey);
  const due = dueOccurrence(spec, today);
  // A due occurrence not yet booked fires on the next run — surface it directly.
  if (due !== null && (lastPeriodKey === null || lastPeriodKey < due)) return due;
  const start = today < spec.startDate ? prevDay(spec.startDate) : today;
  const next = firstAfter(spec, start);
  if (spec.endDate !== null && next > spec.endDate) return null;
  return next;
}

/**
 * The calendar day before `iso` (used to include `startDate` itself in a scan;
 * exported so the restore boundary can resolve the newest strictly-past
 * occurrence via `dueOccurrence(spec, prevDay(today))`).
 */
export function prevDay(iso: string): string {
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
  return skippedPeriods(spec, afterExclusive, throughInclusive, cap).length;
}

/**
 * The concrete occurrence keys counted by {@link skippedPeriodCount}. The
 * execution engine uses these identities only to report which periods its
 * existing newest-only catch-up rule dropped; returning them does not change
 * which occurrence is selected or booked.
 */
export function skippedPeriods(
  spec: ScheduleSpec,
  afterExclusive: string | null,
  throughInclusive: string,
  cap = 400,
): string[] {
  assertSchedule(spec, throughInclusive, afterExclusive);
  const lower = afterExclusive !== null && afterExclusive >= spec.startDate ? afterExclusive : null;
  let cursor = throughInclusive;
  const newestFirst: string[] = [];
  while (newestFirst.length < cap) {
    const previous = mostRecentOnOrBefore(spec, prevDay(cursor));
    if (previous < spec.startDate || (lower !== null && previous <= lower)) break;
    cursor = previous;
    newestFirst.push(previous);
  }
  // Keep the bounded window nearest the current due period. Besides making the
  // aggregation useful for pathological old start dates, this guarantees the
  // final element is always the newest dropped occurrence.
  return newestFirst.reverse();
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
