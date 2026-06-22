import { cx } from '../lib/cx';
import { formatMoney } from '../lib/format';

export interface MoneyTextProps {
  /** Amount in the native currency. */
  amount: number | null | undefined;
  /** ISO 4217 currency code for `amount`. Defaults to `'EUR'`. */
  currency?: string;
  /**
   * Optional EUR-converted equivalent, shown in parentheses after the native
   * amount. Only rendered when the native currency is not already EUR and the
   * value is finite.
   */
  eurAmount?: number | null;
  /**
   * Colour-code by sign — green for gains, red for losses — and prepend `+`
   * for positive values. Use for P&L / day-change deltas. Off by default
   * because most amounts (balances, prices) are not deltas.
   */
  signed?: boolean;
  className?: string;
}

/**
 * Inline money display (PROJECTPLAN.md §7.3 MoneyText): native amount, an
 * optional EUR conversion, sign-coloured when it represents a delta. Pure
 * presentation — all formatting flows through `lib/format`.
 */
export function MoneyText({
  amount,
  currency = 'EUR',
  eurAmount,
  signed = false,
  className,
}: MoneyTextProps) {
  const formatted = formatMoney(amount, currency);

  // Only positive/negative finite deltas get colour and a leading `+`; zero,
  // null and NaN stay neutral.
  const sign = signed && amount != null && Number.isFinite(amount) ? Math.sign(amount) : 0;
  const colorClass = sign > 0 ? 'text-emerald-400' : sign < 0 ? 'text-red-400' : undefined;
  // Intl already emits `-` for negatives; we only need to add the `+`.
  const display = sign > 0 ? `+${formatted}` : formatted;

  const showEur = eurAmount != null && Number.isFinite(eurAmount) && currency !== 'EUR';

  return (
    <span className={cx('tabular-nums', colorClass, className)}>
      {display}
      {showEur ? (
        <span className="ml-1 text-neutral-500">({formatMoney(eurAmount, 'EUR')})</span>
      ) : null}
    </span>
  );
}
