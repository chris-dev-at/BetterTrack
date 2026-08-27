import type { TranslateFn } from '../i18n';

/**
 * Whole seconds → a compact, LOCALIZED duration (#1406 W1 review).
 *
 * The admin console used to build these by hand — `${days}d ${hours}h` — which
 * silently shipped English unit letters into the German console. Units live in
 * the catalog instead, one key per magnitude pair, so a translator can move the
 * unit, change its abbreviation, or reorder the two halves.
 *
 * Takes `t` rather than calling `useT()` so the shared code stays a pure function
 * that a non-component (or a test) can call directly.
 */
export function formatDuration(t: TranslateFn, totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  if (days > 0) return t('admin.common.duration.dayHour', { days, hours });
  if (hours > 0) return t('admin.common.duration.hourMinute', { hours, minutes });
  if (minutes > 0) return t('admin.common.duration.minuteSecond', { minutes, seconds });
  return t('admin.common.duration.second', { seconds });
}

/**
 * A backup/drill age as "N ago", or the explicit never/unknown wording. `null`
 * covers both "no success recorded" and "the timestamp was untrustworthy" — the
 * accompanying reason line is what distinguishes them, so this never invents a
 * number for either.
 */
export function formatBackupAge(t: TranslateFn, ageSeconds: number | null): string {
  if (ageSeconds === null) return t('admin.backup.never');
  return t('admin.backup.ago', { age: formatDuration(t, ageSeconds) });
}
