/**
 * Locale-independent money strings for raw `<input>` VALUES — not display.
 *
 * These feed number inputs whose value is later re-parsed with `Number()`, so
 * they always emit a dot-decimal string (never a locale-grouped one); anything
 * user-facing renders through the shared display kit in `lib/format`. Kept in one
 * module so the input-side rounding rules live together, away from the display rules.
 */

/**
 * A dot-decimal money string for an amount input — the fill-max chip and the
 * quantity⇄amount mode-switch preservation. Rounds half-up to 2 dp (this is a
 * value the user is offered and will edit, not a market quote): `200` → `"200.00"`.
 */
export function amountToInput(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Truncate a money value to 2 decimals for a programmatic autofill — cut to
 * cents, never rounded up (owner directive 2026-07-12). Market-data prefills
 * (a price-at-date lookup, a current-price seed, an alert threshold seeded from
 * the live quote) can carry a raw quote like `231.499320001`; this writes
 * `"231.49"` into the field, so the app never silently rounds a prefilled cent.
 *
 * Truncation is toward zero and done on the decimal STRING (cut after the
 * hundredths digit), NOT via `Math.trunc(value * 100) / 100`: the ×100 would
 * reintroduce binary-float artifacts (e.g. `231.49 * 100 === 23148.999…`, which
 * would truncate to a wrong `231.48`). `Number.prototype.toString` gives the
 * shortest round-tripping decimal, so cutting its digits is exact.
 *
 * Always emits exactly 2 fractional digits (`108` → `"108.00"`, `231.5` →
 * `"231.50"`). Non-finite input yields `""` (leave the field blank, never `NaN`).
 * A sub-cent magnitude (`0 < |value| < 0.01`) collapses to `"0.00"` — cents is
 * the floor of this rule; it is not meant for micro-priced tokens.
 */
export function truncateMoneyForInput(value: number): string {
  if (!Number.isFinite(value)) return '';
  const negative = value < 0;
  const abs = Math.abs(value);

  // Shortest round-tripping decimal — plain (non-exponential) for money-range
  // values; expand the exponential edge (extreme magnitudes) past cents so the
  // digit-cut still works. The extra digits are discarded either way.
  let s = abs.toString();
  if (s.includes('e')) s = abs.toFixed(20);

  const dot = s.indexOf('.');
  const whole = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? '' : s.slice(dot + 1);
  const cents = `${frac}00`.slice(0, 2);
  const body = `${whole}.${cents}`;

  // Keep the sign only when a non-zero magnitude survives the cut (no `-0.00`).
  return negative && Number(body) !== 0 ? `-${body}` : body;
}
