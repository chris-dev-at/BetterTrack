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
  const { year, month } = parseDay(horizon);
  const current = monthlyOccurrence(year, month, schedule.anchorDay);
  const occurrence =
    current <= horizon
      ? current
      : (() => {
          const previous = previousMonth(year, month);
          return monthlyOccurrence(previous.year, previous.month, schedule.anchorDay!);
        })();
  return occurrence >= schedule.startDate ? occurrence : null;
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
