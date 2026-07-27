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

/** The UTC-millisecond calendar coordinate for a requested local wall minute. */
function wallTimeMsFor(year: number, month: number, day: number, minuteOfDay: number): number {
  return Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * MINUTE_MS;
}

/** Every candidate instant the zone can map a requested local wall minute to. */
function wallTimeCandidates(wallTimeMs: number, timezone: string): WallTimeCandidate[] {
  return offsetsAroundWallTime(wallTimeMs, timezone).map((offsetMs) => {
    const instant = new Date(wallTimeMs - offsetMs);
    return { instant, localMinuteMs: localMinuteAsUtc(localParts(instant, timezone)) };
  });
}

/**
 * The effective local-calendar coordinate of a configured boundary. Exact
 * wall times retain their requested coordinate. A spring-forward gap moves the
 * boundary to the first compatible local coordinate after the gap, matching
 * {@link zonedWallTimeToUtc}'s gap-forward instant resolution.
 */
function resolvedWallMinute(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string | null,
): number {
  const wallTimeMs = wallTimeMsFor(year, month, day, minuteOfDay);
  if (!timezone) return wallTimeMs;

  const candidates = wallTimeCandidates(wallTimeMs, timezone);
  if (candidates.some((candidate) => candidate.localMinuteMs === wallTimeMs)) return wallTimeMs;

  // No exact inverse means this is a skipped spring-forward minute. Use the
  // same compatible, gap-forward local coordinate as deadline resolution.
  return (
    candidates
      .filter((candidate) => candidate.localMinuteMs > wallTimeMs)
      .sort(
        (a, b) => a.localMinuteMs - b.localMinuteMs || a.instant.getTime() - b.instant.getTime(),
      )[0]?.localMinuteMs ?? wallTimeMs
  );
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** Offset a local calendar date without inheriting the host machine timezone. */
function shiftCalendarDate(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Find the local calendar date on which the currently active window started.
 *
 * Membership is deliberately evaluated against resolved local boundaries,
 * rather than raw minutes-of-day. This keeps a 01:00→02:30 window active until
 * 03:30 when 02:30 falls in a spring-forward gap, and delays a nonexistent
 * start by the same rule. Repeated fall-back minutes retain their local
 * coordinates, so each occurrence keeps the usual half-open wall-time
 * semantics.
 */
function activeWindowStartDate(config: QuietHoursConfig, at: Date): LocalDate | null {
  if (!hasWindow(config)) return null;

  const local = localParts(at, config.timezone);
  const today: LocalDate = { year: local.year, month: local.month, day: local.day };
  const atWallMinute = localMinuteAsUtc(local);
  const overnight = config.startMinute > config.endMinute;
  const candidateStartDates = overnight ? [today, shiftCalendarDate(today, -1)] : [today];

  for (const startDate of candidateStartDates) {
    const endDate = overnight ? shiftCalendarDate(startDate, 1) : startDate;
    const start = resolvedWallMinute(
      startDate.year,
      startDate.month,
      startDate.day,
      config.startMinute,
      config.timezone,
    );
    const end = resolvedWallMinute(
      endDate.year,
      endDate.month,
      endDate.day,
      config.endMinute,
      config.timezone,
    );
    if (atWallMinute >= start && atWallMinute < end) return startDate;
  }

  return null;
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
  const wallTimeMs = wallTimeMsFor(year, month, day, minuteOfDay);
  if (!timezone) return new Date(wallTimeMs);

  const candidates = wallTimeCandidates(wallTimeMs, timezone);
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

/** Whether `at` is inside the user's quiet-hours window (false when disabled). */
export function isInQuietHours(config: QuietHoursConfig, at: Date): boolean {
  return activeWindowStartDate(config, at) !== null;
}

/**
 * The instant the CURRENT resolved window closes, given `at` is inside it.
 * Callers MUST only invoke this when {@link isInQuietHours} is true.
 */
export function quietHoursWindowEnd(config: QuietHoursConfig, at: Date): Date {
  const local = localParts(at, config.timezone);
  const fallbackStart: LocalDate = { year: local.year, month: local.month, day: local.day };
  // Callers only invoke this for an active window. Keep a deterministic
  // fallback for direct/internal callers that violate that precondition.
  const startDate = activeWindowStartDate(config, at) ?? fallbackStart;
  const endDate =
    config.startMinute > config.endMinute ? shiftCalendarDate(startDate, 1) : startDate;
  return zonedWallTimeToUtc(
    endDate.year,
    endDate.month,
    endDate.day,
    config.endMinute,
    config.timezone,
    at,
  );
}
