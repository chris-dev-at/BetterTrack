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

const MINUTE_MS = 60_000;
const OFFSET_PROBE_RANGE_MS = 36 * 60 * MINUTE_MS;
const OFFSET_PROBE_STEP_MS = 6 * 60 * MINUTE_MS;

/** The UTC-millisecond representation of a local calendar minute. */
function localMinuteAsUtc(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) + parts.minuteOfDay * MINUTE_MS;
}

/**
 * The offsets around a local wall time. `Intl` exposes formatting only, so its
 * inverse must account for both sides of a transition. The probe range covers
 * every real-world offset around the requested local date while keeping the
 * normal (single-offset) path small.
 */
function offsetsAroundWallTime(wallTimeMs: number, timezone: string): number[] {
  const offsets = new Set<number>();
  for (
    let probe = wallTimeMs - OFFSET_PROBE_RANGE_MS;
    probe <= wallTimeMs + OFFSET_PROBE_RANGE_MS;
    probe += OFFSET_PROBE_STEP_MS
  ) {
    const local = localParts(new Date(probe), timezone);
    offsets.add(localMinuteAsUtc(local) - probe);
  }
  return [...offsets];
}

interface WallTimeCandidate {
  instant: Date;
  localMinuteMs: number;
}

/**
 * The UTC instant for a wall-clock time (`minuteOfDay` on local Y/M/D) in
 * `timezone`, strictly after `notBefore`. `Intl` does not provide an inverse
 * timezone conversion, so enumerate each offset observed around the local time
 * and validate it by formatting the candidate back into the zone.
 *
 * A repeated fall-back minute has two valid candidates; selecting the first
 * candidate after `notBefore` keeps a window active through the second local
 * occurrence. A spring-forward gap has no valid candidate; choose the first
 * projected local minute after the requested one, the deterministic compatible
 * (gap-forward) resolution. `timezone` null ⇒ the wall time is UTC.
 */
function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string | null,
  notBefore: Date,
): Date {
  const wallTimeMs = Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * MINUTE_MS;
  if (!timezone) return new Date(wallTimeMs);

  const candidates = offsetsAroundWallTime(wallTimeMs, timezone).map((offsetMs) => {
    const instant = new Date(wallTimeMs - offsetMs);
    return { instant, localMinuteMs: localMinuteAsUtc(localParts(instant, timezone)) };
  });
  const future = (candidate: WallTimeCandidate): boolean =>
    candidate.instant.getTime() > notBefore.getTime();

  // Valid local wall minutes, including both instances during a fall-back.
  const exact = candidates
    .filter((candidate) => candidate.localMinuteMs === wallTimeMs && future(candidate))
    .sort((a, b) => a.instant.getTime() - b.instant.getTime());
  if (exact.length > 0) return exact[0]!.instant;

  // A skipped spring-forward minute has no exact inverse. Of the projections
  // produced by the offsets on each side of the transition, choose the first
  // local minute after the gap, and still never return a stale deadline.
  const compatible = candidates
    .filter((candidate) => candidate.localMinuteMs > wallTimeMs && future(candidate))
    .sort((a, b) => a.localMinuteMs - b.localMinuteMs || a.instant.getTime() - b.instant.getTime());
  if (compatible.length > 0) return compatible[0]!.instant;

  // `quietHoursWindowEnd` only calls us for an active half-open window, where
  // one of the paths above is always future. Retain a deterministic fallback
  // for direct/internal callers with an already-closed wall time.
  return candidates.sort((a, b) => a.instant.getTime() - b.instant.getTime())[0]!.instant;
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
    return zonedWallTimeToUtc(year, month, day, config.endMinute, config.timezone, at);
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
    at,
  );
}
