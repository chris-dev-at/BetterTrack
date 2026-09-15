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

/**
 * The EVENT side of that same comparison (#1894). Every fixture above stamps
 * `…T00:00:00.000Z`, where the UTC day and the Vienna day agree — so the event
 * side kept slicing the UTC substring unnoticed. A payout stamped at 23:30 UTC
 * is RENDERED as the next Vienna day (`formatDate`), so it has to be measured as
 * that day too: otherwise the row is labelled 06.09. and then disappears on the
 * 6th, the one day the reader is looking for it.
 */
describe('dividendDates — the event is placed on the day it renders as (#1894)', () => {
  /** 01:30 Vienna on 6 Sep — the day this payout is printed under. */
  const LATE_UTC = '2026-09-05T23:30:00.000Z';

  const at = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  };

  it('resolves on the display day it is shown as, and stops the day after', () => {
    at('2026-09-05T12:00:00.000Z'); // Vienna 5 Sep — still ahead.
    expect(upcomingDividendDate({ exDate: LATE_UTC, payDate: null })).toEqual({
      iso: LATE_UTC,
      isEx: true,
    });

    at('2026-09-06T12:00:00.000Z'); // Vienna 6 Sep — the day it is labelled.
    expect(upcomingDividendDate({ exDate: LATE_UTC, payDate: null })).toEqual({
      iso: LATE_UTC,
      isEx: true,
    });

    at('2026-09-07T12:00:00.000Z'); // Vienna 7 Sep — it has happened.
    expect(upcomingDividendDate({ exDate: LATE_UTC, payDate: null })).toBeNull();
  });

  it('orders a payload by the rendered day, so the late-UTC event is not "next"', () => {
    at('2026-09-05T12:00:00.000Z');
    const sameViennaDay = { exDate: '2026-09-06T21:00:00.000Z', payDate: null };
    const earlier = { exDate: '2026-09-05T22:00:00.000Z', payDate: null }; // Vienna 6 Sep too
    // Both render as 06.09.; the first listed wins, exactly as the payload's
    // own order intends — what must NOT happen is the 05T22:00 stamp reading as
    // an earlier day than the 06T21:00 one.
    expect(nextUpcomingDividend([sameViennaDay, earlier])).toBe(sameViennaDay);
  });
});
