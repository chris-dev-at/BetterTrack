import { afterEach, describe, expect, it, vi } from 'vitest';

import { nextUpcomingDividend, upcomingDividendDate } from './dividendDates';

/**
 * The day boundary these helpers measure "upcoming" on has to be the day the
 * date is RENDERED in — Vienna wall clock (§7.1), not UTC. Between 00:00 and
 * 02:00 there the UTC day is still yesterday, so a UTC boundary reopened #1758
 * for two hours every night: an event that went ex yesterday kept its "upcoming"
 * label. Both cases below sit inside that window.
 */
const LOCAL_MIDNIGHT_WINDOW = new Date('2026-09-05T23:30:00.000Z'); // 01:30 in Vienna, 6 Sep

afterEach(() => {
  vi.useRealTimers();
});

function inWindow(): void {
  vi.useFakeTimers();
  vi.setSystemTime(LOCAL_MIDNIGHT_WINDOW);
}

describe('dividendDates — the day the date is rendered in (#1827)', () => {
  it('does not resolve an ex-date that is yesterday in the display zone', () => {
    inWindow();
    expect(upcomingDividendDate({ exDate: '2026-09-05T00:00:00.000Z', payDate: null })).toBeNull();
  });

  it('still resolves an ex-date on the display-zone day itself', () => {
    inWindow();
    expect(upcomingDividendDate({ exDate: '2026-09-06T00:00:00.000Z', payDate: null })).toEqual({
      iso: '2026-09-06T00:00:00.000Z',
      isEx: true,
    });
  });

  it('keeps a passed ex-date event whose payout is still ahead, on its pay date', () => {
    inWindow();
    expect(
      upcomingDividendDate({
        exDate: '2026-09-05T00:00:00.000Z',
        payDate: '2026-09-12T00:00:00.000Z',
      }),
    ).toEqual({ iso: '2026-09-12T00:00:00.000Z', isEx: false });
  });

  it('skips a fully past event when picking the next one of a payload', () => {
    inWindow();
    const past = { exDate: '2026-09-05T00:00:00.000Z', payDate: null };
    const ahead = { exDate: '2026-09-20T00:00:00.000Z', payDate: null };
    expect(nextUpcomingDividend([past, ahead])).toBe(ahead);
  });
});
