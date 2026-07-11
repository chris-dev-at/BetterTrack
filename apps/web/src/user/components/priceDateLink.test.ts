import type { PricePoint } from '@bettertrack/contracts';
import { describe, expect, test } from 'vitest';

import {
  dateForPrice,
  priceForDate,
  toDailyPoints,
  weekdayShort,
  type DailyPoint,
} from './priceDateLink';

const p = (date: string, close: number): DailyPoint => ({ date, close });

// A small ascending series with a weekend gap: Fri 2026-06-05 → Mon 2026-06-08.
const series: DailyPoint[] = [
  p('2026-06-01', 100),
  p('2026-06-02', 110),
  p('2026-06-03', 90),
  p('2026-06-04', 95),
  p('2026-06-05', 105), // Friday
  p('2026-06-08', 108), // Monday
];

describe('toDailyPoints', () => {
  test('maps ISO timestamps to day keys, ascending', () => {
    const points: PricePoint[] = [
      { time: '2026-06-02T00:00:00.000Z', close: 110 },
      { time: '2026-06-01T00:00:00.000Z', close: 100 },
    ];
    expect(toDailyPoints(points)).toEqual([p('2026-06-01', 100), p('2026-06-02', 110)]);
  });

  test('collapses duplicate days to the last (freshest) close and drops non-finite', () => {
    const points: PricePoint[] = [
      { time: '2026-06-01T09:00:00.000Z', close: 100 },
      { time: '2026-06-01T16:00:00.000Z', close: 101 },
      { time: '2026-06-02T00:00:00.000Z', close: Number.NaN },
    ];
    expect(toDailyPoints(points)).toEqual([p('2026-06-01', 101)]);
  });
});

describe('priceForDate', () => {
  test('exact trading day returns that close, not adjusted', () => {
    expect(priceForDate(series, '2026-06-03')).toEqual({
      price: 90,
      date: '2026-06-03',
      adjusted: false,
    });
  });

  test('non-trading day falls back to the last trading day before it, adjusted', () => {
    // Saturday 2026-06-06 → Friday 2026-06-05 close.
    expect(priceForDate(series, '2026-06-06')).toEqual({
      price: 105,
      date: '2026-06-05',
      adjusted: true,
    });
  });

  test('a date after the last point uses the last available close, adjusted', () => {
    expect(priceForDate(series, '2026-07-01')).toEqual({
      price: 108,
      date: '2026-06-08',
      adjusted: true,
    });
  });

  test('a date before all history returns null (nothing to fall back to)', () => {
    expect(priceForDate(series, '2026-05-31')).toBeNull();
  });

  test('an empty series returns null', () => {
    expect(priceForDate([], '2026-06-03')).toBeNull();
  });
});

describe('dateForPrice', () => {
  test('exact close on the most recent matching day', () => {
    expect(dateForPrice(series, 108)).toEqual({ date: '2026-06-08', close: 108 });
  });

  test('a price crossed between two closes lands on the later day', () => {
    // 100 lies between 95 (06-04) and 105 (06-05); the more recent crossing is
    // 105→108? no — 100 is not in [105,108]. Most recent containing pair is
    // (95,105) on 06-05.
    expect(dateForPrice(series, 100)).toEqual({ date: '2026-06-05', close: 105 });
  });

  test('an exact historical close is attributed to its own day, not the later boundary day', () => {
    // 105 is the Friday 06-05 close and also the lower bound of the (105 → 108)
    // 06-05→06-08 segment; the exact day wins over the boundary.
    expect(dateForPrice(series, 105)).toEqual({ date: '2026-06-05', close: 105 });
  });

  test('picks the MOST RECENT crossing when a price occurs more than once', () => {
    // 92 lies in (90,95) on 06-04 and also in (110,90) on 06-03 — newest wins.
    expect(dateForPrice(series, 92)).toEqual({ date: '2026-06-04', close: 95 });
  });

  test('a price never reached in history returns null', () => {
    expect(dateForPrice(series, 5)).toBeNull();
    expect(dateForPrice(series, 500)).toBeNull();
  });

  test('single-point series matches only its exact close', () => {
    expect(dateForPrice([p('2026-06-01', 100)], 100)).toEqual({ date: '2026-06-01', close: 100 });
    expect(dateForPrice([p('2026-06-01', 100)], 99)).toBeNull();
  });

  test('non-finite price returns null', () => {
    expect(dateForPrice(series, Number.NaN)).toBeNull();
  });
});

describe('weekdayShort', () => {
  test('names the UTC weekday', () => {
    expect(weekdayShort('2026-06-05')).toBe('Fri');
    expect(weekdayShort('2026-06-08')).toBe('Mon');
    expect(weekdayShort('2026-06-06')).toBe('Sat');
  });
});
