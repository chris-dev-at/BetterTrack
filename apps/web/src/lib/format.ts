/**
 * Shared display-layer formatting for the whole web client (de-AT locale,
 * PROJECTPLAN.md §7.1). Every user-facing number, money amount, percentage and
 * date passes through here so the app speaks one consistent dialect:
 * `1.234,56 €`, `12,3456`, `-2,5 %`, `15.01.2024`.
 *
 * These helpers are pure and prop-driven — no React, no network — so they are
 * equally usable from components, tests and any future non-DOM consumer.
 */

/** Rendered in place of an absent or non-finite value. */
export const EM_DASH = '—';

/**
 * ICU/CLDR separates a number from its currency/percent symbol with a narrow
 * no-break space (U+202F) or a regular no-break space (U+00A0) depending on the
 * locale and ICU version. Collapse both to a plain space so output is stable
 * across Node/browser ICU builds and predictable in DOM text assertions.
 */
function normalizeSpaces(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, ' ');
}

/** Narrow type guard: present, a number, and finite (rejects NaN/±Infinity). */
function isFiniteNumber(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/** Collapse `-0` to `0` so a computed delta never renders a stray leading minus. */
function withoutNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

// ---------------------------------------------------------------------------
// Intl instances — one per distinct shape, created once. Currency formatters
// are memoised per ISO code on first use.

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string): Intl.NumberFormat {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('de-AT', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    moneyFormatters.set(currency, formatter);
  }
  return formatter;
}

// Quantities (e.g. fractional shares): up to 6 dp, no forced trailing zeros.
const quantityFormatter = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 6,
});

// Percent/weight: callers pass a 0–100 magnitude, so divide by 100 — `style:
// 'percent'` scales the input internally and supplies the locale-correct ` %`.
const percentFormatter = new Intl.NumberFormat('de-AT', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Signed percent delta — `exceptZero` prepends `+` for positives, `-` for
// negatives, and nothing for zero.
const signedPercentFormatter = new Intl.NumberFormat('de-AT', {
  style: 'percent',
  signDisplay: 'exceptZero',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Signed plain-number delta (non-currency), always 2 dp.
const signedDeltaFormatter = new Intl.NumberFormat('de-AT', {
  signDisplay: 'exceptZero',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateTimeFormatter = new Intl.DateTimeFormat('de-AT', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const dateFormatter = new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium' });

// ---------------------------------------------------------------------------

/**
 * Money in the asset's native currency, symbol-last, always 2 dp:
 * `formatMoney(1234.56)` → `"1.234,56 €"`, `formatMoney(-50, 'USD')` →
 * `"-50,00 $"`.
 *
 * de-AT's Intl currency output is symbol-*first* (`€ 1.234,56`), but
 * PROJECTPLAN §7.1 mandates symbol-*last* (`1.234,56 €`). We therefore format
 * via `formatToParts`, drop the currency part and the literal separator
 * adjacent to it, and re-append ` <symbol>`. This keeps the number formatting
 * (grouping, decimals, minus placement) exactly as ICU produces it.
 *
 * Returns {@link EM_DASH} for `null`/`undefined`/`NaN`/`Infinity`.
 */
export function formatMoney(value: number | null | undefined, currency = 'EUR'): string {
  if (!isFiniteNumber(value)) return EM_DASH;

  const parts = moneyFormatter(currency).formatToParts(withoutNegativeZero(value));
  const symbol = parts.find((part) => part.type === 'currency')?.value ?? currency;
  const numeric = parts
    .filter((part, index, all) => {
      if (part.type === 'currency') return false;
      // Drop the spacing literal that sits directly beside the currency symbol.
      const beside = all[index - 1]?.type === 'currency' || all[index + 1]?.type === 'currency';
      return !(part.type === 'literal' && beside);
    })
    .map((part) => part.value)
    .join('');

  return normalizeSpaces(`${numeric} ${symbol}`);
}

/**
 * A bare quantity — up to 6 dp, no forced trailing zeros:
 * `formatQuantity(12)` → `"12"`, `formatQuantity(1.1234567)` → `"1,123457"`.
 * Returns {@link EM_DASH} for absent/non-finite values.
 */
export function formatQuantity(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return normalizeSpaces(quantityFormatter.format(withoutNegativeZero(value)));
}

/**
 * A percentage/weight given as a 0–100 magnitude, 1 dp:
 * `formatPercent(2.5)` → `"2,5 %"`, `formatPercent(-2.5)` → `"-2,5 %"`.
 * Returns {@link EM_DASH} for absent/non-finite values.
 */
export function formatPercent(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return normalizeSpaces(percentFormatter.format(withoutNegativeZero(value) / 100));
}

/** Alias of {@link formatPercent} — a conglomerate position weight (0–100). */
export const formatWeight = formatPercent;

/**
 * A signed percentage delta (0–100 magnitude), 1 dp, explicit `+` for gains:
 * `formatSignedPercent(2.5)` → `"+2,5 %"`, `-1.5` → `"-1,5 %"`, `0` → `"0,0 %"`.
 * Returns {@link EM_DASH} for absent/non-finite values.
 */
export function formatSignedPercent(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return normalizeSpaces(signedPercentFormatter.format(withoutNegativeZero(value) / 100));
}

/**
 * A signed plain-number delta, always 2 dp, explicit `+` for gains:
 * `formatSignedDelta(1.25)` → `"+1,25"`, `-50` → `"-50,00"`, `0` → `"0,00"`.
 * Returns {@link EM_DASH} for absent/non-finite values.
 */
export function formatSignedDelta(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return normalizeSpaces(signedDeltaFormatter.format(withoutNegativeZero(value)));
}

/** ISO timestamp → localised date + time, or {@link EM_DASH} when absent/invalid. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? EM_DASH : dateTimeFormatter.format(date);
}

/** ISO timestamp → localised date, or {@link EM_DASH} when absent/invalid. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? EM_DASH : dateFormatter.format(date);
}
