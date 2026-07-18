import { describe, expect, it } from 'vitest';

import { isUrgentNotification } from '@bettertrack/contracts';

import { digestPeriodKey } from '../digestService';
import { isInQuietHours, quietHoursWindowEnd, type QuietHoursConfig } from '../quietHours';

/**
 * Pure quiet-hours window logic (§13.5 V5-P3). Proves the overnight-window
 * acceptance case (defers at 23:00 and 06:00, not 12:00), the window-end
 * computation used to schedule delayed delivery, timezone handling, and the
 * urgent-bypass classifier. No I/O — the clock is a plain argument.
 */

const OVERNIGHT: QuietHoursConfig = {
  enabled: true,
  startMinute: 22 * 60, // 22:00
  endMinute: 7 * 60, // 07:00
  timezone: null, // UTC
};

function utc(iso: string): Date {
  return new Date(iso);
}

describe('quiet-hours window membership', () => {
  it('an overnight 22:00→07:00 window is quiet at 23:00 and 06:00, awake at 12:00', () => {
    expect(isInQuietHours(OVERNIGHT, utc('2026-07-18T23:00:00Z'))).toBe(true);
    expect(isInQuietHours(OVERNIGHT, utc('2026-07-18T06:00:00Z'))).toBe(true);
    expect(isInQuietHours(OVERNIGHT, utc('2026-07-18T12:00:00Z'))).toBe(false);
  });

  it('a same-day window only matches inside [start, end)', () => {
    const day: QuietHoursConfig = {
      enabled: true,
      startMinute: 60,
      endMinute: 6 * 60,
      timezone: null,
    };
    expect(isInQuietHours(day, utc('2026-07-18T03:00:00Z'))).toBe(true);
    expect(isInQuietHours(day, utc('2026-07-18T06:00:00Z'))).toBe(false); // end is exclusive
    expect(isInQuietHours(day, utc('2026-07-18T07:00:00Z'))).toBe(false);
  });

  it('is never quiet when disabled or when start === end (empty window)', () => {
    expect(isInQuietHours({ ...OVERNIGHT, enabled: false }, utc('2026-07-18T23:00:00Z'))).toBe(
      false,
    );
    expect(
      isInQuietHours(
        { enabled: true, startMinute: 300, endMinute: 300, timezone: null },
        utc('2026-07-18T05:00:00Z'),
      ),
    ).toBe(false);
  });

  it('resolves membership in the user timezone, not UTC', () => {
    // 04:00 UTC = 23:00 EST the previous day → inside the 22:00→07:00 window.
    const ny: QuietHoursConfig = { ...OVERNIGHT, timezone: 'America/New_York' };
    expect(isInQuietHours(ny, utc('2026-01-15T04:00:00Z'))).toBe(true);
    // 18:00 UTC = 13:00 EST → awake.
    expect(isInQuietHours(ny, utc('2026-01-15T18:00:00Z'))).toBe(false);
  });
});

describe('quiet-hours window end', () => {
  it('the evening portion of an overnight window ends the NEXT morning', () => {
    const end = quietHoursWindowEnd(OVERNIGHT, utc('2026-07-18T23:00:00Z'));
    expect(end.toISOString()).toBe('2026-07-19T07:00:00.000Z');
  });

  it('the post-midnight tail ends the SAME morning', () => {
    const end = quietHoursWindowEnd(OVERNIGHT, utc('2026-07-18T06:00:00Z'));
    expect(end.toISOString()).toBe('2026-07-18T07:00:00.000Z');
  });

  it('a same-day window ends later the same day', () => {
    const day: QuietHoursConfig = {
      enabled: true,
      startMinute: 60,
      endMinute: 6 * 60,
      timezone: null,
    };
    const end = quietHoursWindowEnd(day, utc('2026-07-18T03:00:00Z'));
    expect(end.toISOString()).toBe('2026-07-18T06:00:00.000Z');
  });

  it('computes the end instant in the user timezone', () => {
    const ny: QuietHoursConfig = { ...OVERNIGHT, timezone: 'America/New_York' };
    // At 23:00 EST on Jan 14 (04:00 UTC Jan 15) the window ends 07:00 EST Jan 15
    // = 12:00 UTC.
    const end = quietHoursWindowEnd(ny, utc('2026-01-15T04:00:00Z'));
    expect(end.toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });
});

describe('digest period bucketing by local day (§13.5 V5-P3)', () => {
  it('buckets by the user LOCAL day when a timezone is set; by UTC without one', () => {
    const at = utc('2026-07-18T23:30:00Z');
    // Sydney is UTC+10 in July → already the 19th locally.
    expect(digestPeriodKey('daily', at, 'Australia/Sydney')).toBe('d:2026-07-19');
    // No timezone falls back to UTC — byte-identical to the pre-quiet-hours key.
    expect(digestPeriodKey('daily', at, null)).toBe('d:2026-07-18');
    expect(digestPeriodKey('daily', at)).toBe('d:2026-07-18');
  });
});

describe('urgent-bypass class (§13.5 V5-P3, §16-logged)', () => {
  it('account/security types and critical announcements bypass; price alerts do not', () => {
    expect(isUrgentNotification({ type: 'account.invite' })).toBe(true);
    expect(isUrgentNotification({ type: 'account.temp_password' })).toBe(true);
    expect(isUrgentNotification({ type: 'account.data_export' })).toBe(true);
    expect(isUrgentNotification({ type: 'friend.request', announcementSeverity: 'critical' })).toBe(
      true,
    );
    // The whole point of quiet hours — market noise never bypasses.
    expect(isUrgentNotification({ type: 'alert.triggered' })).toBe(false);
    expect(isUrgentNotification({ type: 'friend.request' })).toBe(false);
    expect(isUrgentNotification({ type: 'friend.request', announcementSeverity: 'info' })).toBe(
      false,
    );
  });
});
