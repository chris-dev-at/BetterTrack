import type { StandingOrderCadence } from '@bettertrack/contracts';

export interface StandingOrderSchedule {
  cadence: StandingOrderCadence;
  anchorDay: number | null;
  startDate: string;
  endDate: string | null;
}

interface DayParts {
  year: number;
  month: number;
  day: number;
}

function parseDay(day: string): DayParts {
  const [year, month, date] = day.split('-').map(Number);
  return { year: year!, month: month!, day: date! };
}

function formatDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function clampDay(year: number, month: number, anchorDay: number): number {
  return Math.min(anchorDay, daysInMonth(year, month));
}

function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function monthlyOccurrence(year: number, month: number, anchorDay: number): string {
  return formatDay(year, month, clampDay(year, month, anchorDay));
}

/**
 * Matches the server scheduler's most-recent-only catch-up rule: one newest
 * occurrence is returned after downtime, never an accumulated backlog.
 */
export function dueStandingOrderOccurrence(
  schedule: StandingOrderSchedule,
  today: string,
): string | null {
  assertSchedule(schedule, today);
  const horizon = schedule.endDate !== null && schedule.endDate < today ? schedule.endDate : today;
  if (horizon < schedule.startDate) return null;
  if (schedule.cadence === 'daily') return horizon;

  if (schedule.anchorDay === null) return null;
  const anchorDay = schedule.anchorDay;
  const { year, month } = parseDay(horizon);
  const current = monthlyOccurrence(year, month, anchorDay);
  const occurrence =
    current <= horizon
      ? current
      : (() => {
          const previous = previousMonth(year, month);
          return monthlyOccurrence(previous.year, previous.month, anchorDay);
        })();
  return occurrence >= schedule.startDate ? occurrence : null;
}

/**
 * The next unbooked occurrence shown by the vault-backed management UI. This
 * mirrors the server scheduler: an overdue period wins; otherwise return the
 * first schedule day strictly after today, capped by the order's end date.
 */
export function nextStandingOrderRunDate(
  schedule: StandingOrderSchedule,
  today: string,
  lastPeriodKey: string | null,
  active: boolean,
): string | null {
  if (!active) return null;
  const due = dueStandingOrderOccurrence(schedule, today);
  if (due !== null && (lastPeriodKey === null || lastPeriodKey < due)) return due;

  let next: string;
  if (schedule.cadence === 'daily') {
    next = today < schedule.startDate ? schedule.startDate : nextCalendarDay(today);
  } else {
    // Same guard as `dueStandingOrderOccurrence`: a monthly schedule without an
    // anchor has no occurrence to point at. Unreachable while the contract
    // requires `anchorDay` for monthly — but reading it as `31 - undefined`
    // would render `YYYY-MM-00`, and a date that does not exist is worse than
    // an honest "nothing scheduled".
    if (schedule.anchorDay === null) return null;
    const anchorDay = schedule.anchorDay;
    const baseline = today < schedule.startDate ? schedule.startDate : today;
    const { year, month } = parseDay(baseline);
    const inMonth = monthlyOccurrence(year, month, anchorDay);
    if (inMonth > today && inMonth >= schedule.startDate) {
      next = inMonth;
    } else {
      const following = nextMonth(year, month);
      next = monthlyOccurrence(following.year, following.month, anchorDay);
    }
  }
  return schedule.endDate !== null && next > schedule.endDate ? null : next;
}

/**
 * The first scheduled occurrence that has not been satisfied by the persisted
 * watermark. Unlike the most-recent-only catch-up date, this stays pinned to
 * the beginning of a deferral so UI notices do not roll forward on every scan.
 */
export function oldestUnbookedStandingOrderDueDate(
  schedule: StandingOrderSchedule,
  lastPeriodKey: string | null,
): string | null {
  assertSchedule(schedule, lastPeriodKey ?? schedule.startDate);
  const afterWatermark =
    lastPeriodKey === null ? schedule.startDate : nextCalendarDay(lastPeriodKey);
  const earliest = afterWatermark < schedule.startDate ? schedule.startDate : afterWatermark;
  if (schedule.endDate !== null && earliest > schedule.endDate) return null;
  if (schedule.cadence === 'daily') return earliest;

  const anchorDay = schedule.anchorDay;
  if (anchorDay === null) return null;
  const { year, month } = parseDay(earliest);
  const inMonth = monthlyOccurrence(year, month, anchorDay);
  const first =
    inMonth >= earliest
      ? inMonth
      : (() => {
          const following = nextMonth(year, month);
          return monthlyOccurrence(following.year, following.month, anchorDay);
        })();
  return schedule.endDate !== null && first > schedule.endDate ? null : first;
}

function nextCalendarDay(day: string): string {
  const { year, month, day: date } = parseDay(day);
  if (date < daysInMonth(year, month)) return formatDay(year, month, date + 1);
  const following = nextMonth(year, month);
  return formatDay(following.year, following.month, 1);
}

/**
 * Membership of `day` in the order's cadence/anchor/startDate lattice,
 * ignoring the CURRENT endDate. The server lets `endDate` shrink after
 * periods were legally booked (update() only enforces `endDate >= startDate`),
 * so endDate governs future dueness — never the validity of already-persisted
 * runs and watermarks. Use {@link dueStandingOrderOccurrence} for new bookings.
 */
export function isStandingOrderScheduleDay(schedule: StandingOrderSchedule, day: string): boolean {
  return dueStandingOrderOccurrence({ ...schedule, endDate: null }, day) === day;
}

function assertSchedule(schedule: StandingOrderSchedule, today: string): void {
  for (const [label, day] of [
    ['today', today],
    ['startDate', schedule.startDate],
    ['endDate', schedule.endDate],
  ] as const) {
    if (day !== null && !isCalendarDay(day)) {
      throw new RangeError(`${label} must be a real ISO calendar day.`);
    }
  }
  if (schedule.endDate !== null && schedule.endDate < schedule.startDate) {
    throw new RangeError('Standing-order endDate precedes startDate.');
  }
  if (
    (schedule.cadence === 'daily' && schedule.anchorDay !== null) ||
    (schedule.cadence === 'monthly' &&
      (schedule.anchorDay === null ||
        !Number.isInteger(schedule.anchorDay) ||
        schedule.anchorDay < 1 ||
        schedule.anchorDay > 31))
  ) {
    throw new RangeError('Standing-order cadence and anchorDay are inconsistent.');
  }
}

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
 * The one timezone the standing-order schedule speaks in — the server scan's
 * `STANDING_ORDERS_SCAN_TZ` (`services/standingOrders/standingOrderService.ts`),
 * mirrored here so the vault twin and every surface that has to agree with the
 * schedule ("which day is it?") resolve the same calendar day.
 */
export const STANDING_ORDER_SCHEDULE_TZ = 'Europe/Vienna';

/** Resolve an instant to the same calendar day the user-facing schedule uses. */
export function calendarDayInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError(`Unable to resolve calendar day in timezone ${timezone}.`);
  }
  return day;
}
