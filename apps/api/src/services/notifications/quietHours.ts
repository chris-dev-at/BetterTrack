/**
 * Pure, clock-injected quiet-hours window logic (§13.5 V5-P3). No I/O, no
 * ambient clock — every function takes the instant to evaluate against, so the
 * dispatcher and the digest job can defer deterministically and the tests can
 * mock the clock. Timezone handling is dependency-free: it rides `Intl`, the
 * same engine the contract's `ianaTimeZoneSchema` validates against.
 *
 * A window is `[startMinute, endMinute)` in minutes-since-local-midnight. When
 * `start < end` it is a same-day window (e.g. 01:00→06:00); when `start > end`
 * it is an OVERNIGHT window that wraps midnight (e.g. 22:00→07:00). `start ===
 * end` is treated as an empty window (never in quiet hours) — the settings UI
 * never produces it, and reading it as "always quiet" would silently trap a
 * user's outbound notifications forever.
 */

export interface QuietHoursConfig {
  enabled: boolean;
  /** Minutes since local midnight the window opens (0..1439). */
  startMinute: number;
  /** Minutes since local midnight the window closes (0..1439). */
  endMinute: number;
  /** IANA timezone name; null = UTC (the pre-quiet-hours behaviour). */
  timezone: string | null;
}

/** The local Y/M/D + minute-of-day of an instant in a timezone (null = UTC). */
interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number;
  minuteOfDay: number;
}

/** Decompose an instant into its wall-clock parts in `timezone` (null ⇒ UTC). */
function localParts(at: Date, timezone: string | null): LocalParts {
  if (!timezone) {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      minuteOfDay: at.getUTCHours() * 60 + at.getUTCMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    minuteOfDay: get('hour') * 60 + get('minute'),
  };
}

/** The local calendar date (Y/M/D) of an instant in a timezone (null ⇒ UTC). */
export function zonedCalendarDate(
  at: Date,
  timezone: string | null,
): { year: number; month: number; day: number } {
  const { year, month, day } = localParts(at, timezone);
  return { year, month, day };
}

/**
 * The UTC instant for a wall-clock time (`minuteOfDay` on local Y/M/D) in
 * `timezone`. Resolves the zone offset AT that instant (so it is DST-correct to
 * the standard single-adjustment precision), then inverts it. `timezone` null ⇒
 * the wall time is UTC.
 */
function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string | null,
): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  if (!timezone) return new Date(utcGuess);
  // Offset (localWall − UTC) at the guessed instant: format the guess back in
  // the zone and diff against the UTC fields it stands for.
  const p = localParts(new Date(utcGuess), timezone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) + p.minuteOfDay * 60_000;
  const offsetMs = wallAsUtc - utcGuess;
  return new Date(utcGuess - offsetMs);
}

/** Whether the window is a real (non-empty) window. */
function hasWindow(config: QuietHoursConfig): boolean {
  return config.enabled && config.startMinute !== config.endMinute;
}

/** Whether a local minute-of-day falls inside the (possibly overnight) window. */
function minuteInWindow(minuteOfDay: number, startMinute: number, endMinute: number): boolean {
  if (startMinute < endMinute) return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  // Overnight: [start, 1440) ∪ [0, end).
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/** Whether `at` is inside the user's quiet-hours window (false when disabled). */
export function isInQuietHours(config: QuietHoursConfig, at: Date): boolean {
  if (!hasWindow(config)) return false;
  const { minuteOfDay } = localParts(at, config.timezone);
  return minuteInWindow(minuteOfDay, config.startMinute, config.endMinute);
}

/**
 * The instant the CURRENT window closes, given `at` is inside it. For a same-day
 * window it is today's `endMinute`; for an overnight window it is today's
 * `endMinute` when `at` is in the post-midnight tail, else tomorrow's. Callers
 * MUST only invoke this when {@link isInQuietHours} is true.
 */
export function quietHoursWindowEnd(config: QuietHoursConfig, at: Date): Date {
  const { year, month, day, minuteOfDay } = localParts(at, config.timezone);
  // Overnight window and we are already past midnight (minuteOfDay < end) ⇒ the
  // window closes later TODAY; every other in-window case closes on the local
  // day whose `endMinute` comes next.
  const overnightTail = config.startMinute > config.endMinute && minuteOfDay < config.endMinute;
  const endIsToday = config.startMinute < config.endMinute || overnightTail;
  if (endIsToday) {
    return zonedWallTimeToUtc(year, month, day, config.endMinute, config.timezone);
  }
  // Tomorrow's local end minute. `Date.UTC` normalizes the month/year rollover;
  // resolving the offset on that calendar day keeps it DST-correct.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return zonedWallTimeToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    config.endMinute,
    config.timezone,
  );
}
