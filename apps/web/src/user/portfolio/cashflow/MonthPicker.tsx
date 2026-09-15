import { useI18n, useT } from '../../../i18n';
import { displayZoneMonth } from '../../../lib/format';

/**
 * Which month you are looking at — as a pair of arrows and the month's NAME,
 * not a bare `<input type="month">` (owner, 2026-07-31: the plain input "is
 * goofy").
 *
 * Two reasons the input had to go. It renders as a locale-dependent numeric
 * field ("2026-07" or "07/2026" depending on the browser), which is a poor way
 * to say "July"; and moving one month — overwhelmingly the thing people do
 * here — meant editing a number rather than pressing a direction.
 *
 * The month is abbreviated ("Jul 2026"): the control was sized for
 * "September" and spent most of the year housing three letters.
 *
 * Forward is disabled at the current month: the ledger cannot contain the
 * future, so an enabled arrow would only ever lead to an empty page.
 */

export interface MonthPickerProps {
  /** `YYYY-MM`. */
  value: string;
  onChange: (next: string) => void;
}

/**
 * The current calendar month `YYYY-MM` on the ledger's clock — the server's own
 * period key (#1792). The UTC month it used to be is the PREVIOUS month between
 * 00:00 and 02:00 Vienna, so this surface opened on a month the ledger had
 * already left.
 */
function currentMonth(): string {
  return displayZoneMonth();
}

/** `YYYY-MM` shifted by whole months, without tripping over year boundaries. */
function shift(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year!, index! - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

export function MonthPicker({ value, onChange }: MonthPickerProps) {
  const t = useT();
  const { locale } = useI18n();

  const [year, index] = value.split('-').map(Number);
  const label = new Date(Date.UTC(year!, index! - 1, 1)).toLocaleDateString(locale, {
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  });
  const atCurrent = value >= currentMonth();

  return (
    <span aria-label={t('cashflow.overview.month')} className="bt-monthpick" role="group">
      <button
        aria-label={t('cashflow.overview.previousMonth')}
        className="bt-monthpick__arrow"
        onClick={() => onChange(shift(value, -1))}
        title={t('cashflow.overview.previousMonth')}
        type="button"
      >
        ‹
      </button>
      <span className="bt-monthpick__label">{label}</span>
      <button
        aria-label={t('cashflow.overview.nextMonth')}
        className="bt-monthpick__arrow"
        disabled={atCurrent}
        onClick={() => onChange(shift(value, 1))}
        title={t('cashflow.overview.nextMonth')}
        type="button"
      >
        ›
      </button>
    </span>
  );
}
