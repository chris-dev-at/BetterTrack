import { cx } from '../lib/cx';
import { formatMoney, formatUnitPrice, getMoneyCurrency } from '../lib/format';

export interface MoneyTextProps {
  /** The amount. */
  amount: number | null | undefined;
  /**
   * ISO 4217 currency code for `amount`. Defaults to the user's base currency
   * (§5.4, V3-P10d) — the denomination the API's converted figures arrive in.
   * Pass it explicitly for amounts in any other denomination (an asset's
   * native price, the EUR-native cash ledger).
   */
  currency?: string;
  /**
   * Optional base-currency-converted equivalent, shown in parentheses after
   * the native amount. Only rendered when the native currency differs from the
   * user's base and the value is finite.
   */
  convertedAmount?: number | null;
  /**
   * Colour-code by sign — green for gains, red for losses — and prepend `+`
   * for positive values. Use for P&L / day-change deltas. Off by default
   * because most amounts (balances, prices) are not deltas.
   */
  signed?: boolean;
  /**
   * Render as a per-unit **price** (§7.1 rule 4): a sub-cent value keeps up to 6
   * significant decimals so a micro-cap token price (€0.000012) is not rounded
   * away to €0,00. Off by default — balances/totals/fees use the 2 dp money rule.
   */
  unitPrice?: boolean;
  className?: string;
}

/**
 * Inline money display (PROJECTPLAN.md §7.3 MoneyText): the amount in its own
 * currency, an optional conversion into the user's base currency,
 * sign-coloured when it represents a delta. Pure presentation — all
 * formatting flows through `lib/format`.
 */
export function MoneyText({
  amount,
  currency,
  convertedAmount,
  signed = false,
  unitPrice = false,
  className,
}: MoneyTextProps) {
  const base = getMoneyCurrency();
  const effectiveCurrency = currency ?? base;
  const format = unitPrice ? formatUnitPrice : formatMoney;
  const formatted = format(amount, effectiveCurrency);

  // Only positive/negative finite deltas get colour and a leading `+`; zero,
  // null and NaN stay neutral.
  const sign = signed && amount != null && Number.isFinite(amount) ? Math.sign(amount) : 0;
  const colorClass = sign > 0 ? 'text-emerald-400' : sign < 0 ? 'text-red-400' : undefined;
  // Intl already emits `-` for negatives; we only need to add the `+`.
  const display = sign > 0 ? `+${formatted}` : formatted;

  const showConverted =
    convertedAmount != null && Number.isFinite(convertedAmount) && effectiveCurrency !== base;

  return (
    <span className={cx('tabular-nums', colorClass, className)}>
      {display}
      {showConverted ? (
        <span className="ml-1 text-neutral-500">({format(convertedAmount, base)})</span>
      ) : null}
    </span>
  );
}
