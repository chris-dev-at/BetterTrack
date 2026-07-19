import { describe, expect, it } from 'vitest';

import {
  calendarDayInTimezone,
  clampDay,
  daysInMonth,
  dueOccurrence,
  nextRunDate,
  skippedPeriodCount,
  type ScheduleSpec,
} from '../schedule';

const daily = (startDate: string, endDate: string | null = null): ScheduleSpec => ({
  cadence: 'daily',
  anchorDay: null,
  startDate,
  endDate,
});

const monthly = (
  anchorDay: number,
  startDate: string,
  endDate: string | null = null,
): ScheduleSpec => ({ cadence: 'monthly', anchorDay, startDate, endDate });

describe('standing-order schedule: daysInMonth / clampDay', () => {
  it('knows real month lengths, leap years included', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29); // leap
    expect(daysInMonth(2100, 2)).toBe(28); // century non-leap
    expect(daysInMonth(2000, 2)).toBe(29); // 400-divisible leap
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 1)).toBe(31);
  });

  it('clamps a day-31 anchor to each month’s end', () => {
    expect(clampDay(2026, 2, 31)).toBe(28);
    expect(clampDay(2024, 2, 31)).toBe(29);
    expect(clampDay(2026, 4, 31)).toBe(30);
    expect(clampDay(2026, 1, 31)).toBe(31);
    expect(clampDay(2026, 3, 15)).toBe(15); // no clamp needed
  });
});

describe('standing-order schedule: dueOccurrence (daily)', () => {
  it('is today itself once started, and null before the start', () => {
    expect(dueOccurrence(daily('2026-03-10'), '2026-03-09')).toBeNull();
    expect(dueOccurrence(daily('2026-03-10'), '2026-03-10')).toBe('2026-03-10');
    expect(dueOccurrence(daily('2026-03-10'), '2026-03-20')).toBe('2026-03-20');
  });

  it('never returns an occurrence past the (inclusive) end date', () => {
    const spec = daily('2026-03-10', '2026-03-12');
    expect(dueOccurrence(spec, '2026-03-11')).toBe('2026-03-11');
    // Today is past the end → the horizon caps at the end, returning its last day.
    expect(dueOccurrence(spec, '2026-03-20')).toBe('2026-03-12');
  });
});

describe('standing-order schedule: dueOccurrence (monthly, clamping)', () => {
  const spec = monthly(31, '2026-01-01');

  it('fires on the anchor when it has arrived, else last month’s', () => {
    expect(dueOccurrence(spec, '2026-01-31')).toBe('2026-01-31');
    expect(dueOccurrence(spec, '2026-02-27')).toBe('2026-01-31'); // Feb anchor not reached yet
  });

  it('clamps the anchor to month-end in shorter months', () => {
    expect(dueOccurrence(spec, '2026-02-28')).toBe('2026-02-28'); // 31 → Feb 28
    expect(dueOccurrence(monthly(31, '2024-01-01'), '2024-02-29')).toBe('2024-02-29'); // leap
    expect(dueOccurrence(spec, '2026-04-30')).toBe('2026-04-30'); // 31 → Apr 30
    expect(dueOccurrence(spec, '2026-04-29')).toBe('2026-03-31'); // April anchor not reached
  });

  it('respects the start date (an anchor before the start does not fire)', () => {
    const late = monthly(15, '2026-01-20');
    expect(dueOccurrence(late, '2026-01-25')).toBeNull(); // Jan 15 < start
    expect(dueOccurrence(late, '2026-02-15')).toBe('2026-02-15');
  });
});

describe('standing-order schedule: nextRunDate', () => {
  it('surfaces an unbooked due occurrence, else the next one', () => {
    const spec = daily('2026-03-10');
    // Overdue / unbooked → the due day (fires next run).
    expect(nextRunDate(spec, '2026-03-10', null, true)).toBe('2026-03-10');
    // Already booked today → tomorrow.
    expect(nextRunDate(spec, '2026-03-10', '2026-03-10', true)).toBe('2026-03-11');
    // Before the start → the start day is the first run.
    expect(nextRunDate(spec, '2026-03-08', null, true)).toBe('2026-03-10');
  });

  it('is null when paused or past the end date', () => {
    const spec = monthly(31, '2026-01-01', '2026-03-31');
    expect(nextRunDate(spec, '2026-03-31', '2026-03-31', false)).toBeNull(); // paused
    expect(nextRunDate(spec, '2026-03-31', '2026-03-31', true)).toBeNull(); // exhausted
    expect(nextRunDate(spec, '2026-02-28', '2026-02-28', true)).toBe('2026-03-31'); // next anchor
  });
});

describe('standing-order schedule: skippedPeriodCount', () => {
  it('counts occurrences strictly between the last booked and the due day', () => {
    // Downtime since the start: Apr 1/2/3 are skipped when booking Apr 4.
    expect(skippedPeriodCount(daily('2026-04-01'), null, '2026-04-04')).toBe(3);
    // Since the last booked Apr 1: only Apr 2/3 are skipped.
    expect(skippedPeriodCount(daily('2026-04-01'), '2026-04-01', '2026-04-04')).toBe(2);
    // Monthly: Jan/Feb/Mar skipped when booking April.
    expect(skippedPeriodCount(monthly(1, '2026-01-01'), null, '2026-04-01')).toBe(3);
    // Fresh (due is the very first occurrence) → nothing skipped.
    expect(skippedPeriodCount(daily('2026-04-01'), null, '2026-04-01')).toBe(0);
  });
});

describe('standing-order schedule: calendarDayInTimezone', () => {
  it('maps an instant to its calendar day in the given zone', () => {
    const noon = Date.parse('2026-03-15T12:00:00Z');
    expect(calendarDayInTimezone(noon, 'Europe/Vienna')).toBe('2026-03-15');
    expect(calendarDayInTimezone(noon, 'UTC')).toBe('2026-03-15');
    // Late UTC evening is already the next day in Vienna (+1/+2).
    const lateEvening = Date.parse('2026-03-15T23:30:00Z');
    expect(calendarDayInTimezone(lateEvening, 'Europe/Vienna')).toBe('2026-03-16');
    expect(calendarDayInTimezone(lateEvening, 'UTC')).toBe('2026-03-15');
  });
});
