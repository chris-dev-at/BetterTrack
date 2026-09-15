import { getFormatLocale } from '../../../lib/format';

/**
 * The instant the endpoint accepts a device password again. Seconds are shown on
 * purpose: §12's first rung is 30 s, and a bare "14:32" would read as a minute
 * of wait for a half-minute lockout.
 *
 * Shared by every surface that can meet the same lockout — the QR sender and the
 * vault access surface — so one lockout never reads as two different deadlines.
 */
export function vaultRetryTimeLabel(retryAt: number): string {
  try {
    return new Intl.DateTimeFormat(getFormatLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(retryAt));
  } catch {
    return new Date(retryAt).toISOString();
  }
}
