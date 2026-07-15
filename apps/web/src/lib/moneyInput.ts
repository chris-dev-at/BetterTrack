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
 *
 * **Sub-cent carve-out** (owner ruling 2026-07-14, mobile ask #29 item 1): a
 * genuine sub-cent magnitude (`0 < |value| < 0.01`) must stay visible and
 * editable instead of collapsing to `"0.00"`, so it keeps up to **6 significant
 * decimals, truncated** — the input-side mirror of `formatUnitPrice`'s display
 * rule (§7.1 rule 4): `0.000012` → `"0.000012"`, a raw micro-cap quote like
 * `0.0000123456789` → `"0.0000123456"`. Same string-cut discipline as the cents
 * path — never a ×10ⁿ float round-trip. Only a magnitude too small for even 6
 * significant decimals within the 20-digit expansion still yields `"0.00"`.
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

  // Sub-cent branch: cut after the 6th significant fractional digit (leading
  // zeros don't count), then trim trailing zeros so the field shows the value
  // the way a user would type it (`0.005`, not `0.00500000`).
  if (abs > 0 && abs < 0.01) {
    const firstSignificant = frac.search(/[^0]/);
    if (firstSignificant === -1) return '0.00'; // below toFixed(20) resolution
    const digits = frac.slice(0, firstSignificant + 6).replace(/0+$/, '');
    const body = `0.${digits}`;
    return negative ? `-${body}` : body;
  }

  const cents = `${frac}00`.slice(0, 2);
  const body = `${whole}.${cents}`;

  // Keep the sign only when a non-zero magnitude survives the cut (no `-0.00`).
  return negative && Number(body) !== 0 ? `-${body}` : body;
}
