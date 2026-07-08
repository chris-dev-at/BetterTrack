/**
 * Shared display-layer formatting for the whole web client (PROJECTPLAN.md §7.1,
 * §13.3 V3-P1). Every user-facing number, money amount, percentage and date
 * passes through here so the app speaks one consistent dialect.
 *
 * **Locale-aware (V3-P1).** The active Intl locale is a module-level setting the
 * i18n runtime drives via {@link setFormatLocale} (`de-AT` for German, `en-GB`
 * for English, …), so numbers/dates follow the user's chosen language:
 * `1.234,56 €` / `15.01.2024` in de-AT, `1,234.56 €` / `15 Jan 2024` in en-GB.
 * Dates always render in the **Europe/Vienna** wall-clock (§5.5). Money stays
 * symbol-LAST in every locale (§7.1). The default is `de-AT` so pure unit tests
 * and any non-UI consumer get deterministic output without a provider; the live
 * app always sets the real locale before first paint.
 *
 * These helpers are pure and prop-driven — no React, no network — so they are
 * equally usable from components, tests and any future non-DOM consumer.
 */

/** Rendered in place of an absent or non-finite value. */
export const EM_DASH = '—';

/** Dates always display in Vienna wall-clock, regardless of host timezone (§5.5). */
const DISPLAY_TIME_ZONE = 'Europe/Vienna';

/**
 * The active Intl locale. Defaults to `de-AT` (the app's original single dialect)
 * so tests and non-UI callers are deterministic; the i18n provider overrides it
 * to the user's locale before the first UI paint.
 */
let activeLocale = 'de-AT';

/** Switch the locale all formatters use (called by the i18n runtime). */
export function setFormatLocale(locale: string): void {
  activeLocale = locale;
}

/** The active Intl locale — exposed for tests/diagnostics. */
export function getFormatLocale(): string {
  return activeLocale;
}

/**
 * The active default money currency — the signed-in user's **base currency**
 * (§5.4, §13.3 V3-P10d). The auth runtime drives it from the session user
 * (EUR default, matching the API's default base), so every `formatMoney` /
 * `MoneyText` call that doesn't name a currency renders in the user's base —
 * which is exactly the denomination the API's converted figures arrive in.
 * Amounts that are NOT in the user's base (an asset's native price, the
 * EUR-native cash ledger) must keep passing their currency explicitly.
 */
let activeCurrency = 'EUR';

/** Switch the default money currency (called by the auth runtime). */
export function setMoneyCurrency(currency: string): void {
  activeCurrency = currency;
}

/** The active default money currency — the user's base (§5.4). */
export function getMoneyCurrency(): string {
  return activeCurrency;
}

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
// Intl instances — memoised per active locale (and, for money, per ISO code),
// so switching languages never rebuilds a formatter that already exists.

interface LocaleFormatters {
  quantity: Intl.NumberFormat;
  percent: Intl.NumberFormat;
  signedPercent: Intl.NumberFormat;
  signedDelta: Intl.NumberFormat;
  dateTime: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
  money: Map<string, Intl.NumberFormat>;
}

const localeCache = new Map<string, LocaleFormatters>();

function formatters(): LocaleFormatters {
  let cached = localeCache.get(activeLocale);
  if (!cached) {
    cached = {
      // Quantities (e.g. fractional shares): up to 6 dp, no forced trailing zeros.
      quantity: new Intl.NumberFormat(activeLocale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 6,
      }),
      // Percent/weight: callers pass a 0–100 magnitude, so divide by 100 — `style:
      // 'percent'` scales the input internally and supplies the locale-correct symbol.
      percent: new Intl.NumberFormat(activeLocale, {
        style: 'percent',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
      // Signed percent delta — `exceptZero` prepends `+`/`-`, nothing for zero.
      signedPercent: new Intl.NumberFormat(activeLocale, {
        style: 'percent',
        signDisplay: 'exceptZero',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
      // Signed plain-number delta (non-currency), always 2 dp.
      signedDelta: new Intl.NumberFormat(activeLocale, {
        signDisplay: 'exceptZero',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      dateTime: new Intl.DateTimeFormat(activeLocale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: DISPLAY_TIME_ZONE,
      }),
      date: new Intl.DateTimeFormat(activeLocale, {
        dateStyle: 'medium',
        timeZone: DISPLAY_TIME_ZONE,
      }),
      money: new Map(),
    };
    localeCache.set(activeLocale, cached);
  }
  return cached;
}

function moneyFormatter(currency: string): Intl.NumberFormat {
  const cache = formatters().money;
  let formatter = cache.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(activeLocale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    cache.set(currency, formatter);
  }
  return formatter;
}

// ---------------------------------------------------------------------------

/**
 * Money, symbol-last, always 2 dp: `formatMoney(1234.56)` → `"1.234,56 €"`
 * (de-AT, EUR base), `formatMoney(-50, 'USD')` → `"-50,00 $"`. The currency
 * defaults to the user's **base currency** ({@link setMoneyCurrency}) — pass it
 * explicitly for amounts in any other denomination (native asset prices, the
 * EUR-native cash ledger).
 *
 * Intl currency output is often symbol-*first* (`€ 1.234,56`), but PROJECTPLAN
 * §7.1 mandates symbol-*last* (`1.234,56 €`) in every locale. We therefore format
 * via `formatToParts`, drop the currency part and the literal separator adjacent
 * to it, and re-append ` <symbol>`. This keeps the number formatting (grouping,
 * decimals, minus placement) exactly as ICU produces it for the active locale.
 *
 * Returns {@link EM_DASH} for `null`/`undefined`/`NaN`/`Infinity`.
 */
export function formatMoney(value: number | null | undefined, currency?: string): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  currency ??= activeCurrency;

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
  return normalizeSpaces(formatters().quantity.format(withoutNegativeZero(value)));
}

/**
 * A percentage/weight given as a 0–100 magnitude, 1 dp:
 * `formatPercent(2.5)` → `"2,5 %"`, `formatPercent(-2.5)` → `"-2,5 %"`.
 * Returns {@link EM_DASH} for absent/non-finite values.
 */
export function formatPercent(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return normalizeSpaces(formatters().percent.format(withoutNegativeZero(value) / 100));
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
  return normalizeSpaces(formatters().signedPercent.format(withoutNegativeZero(value) / 100));
}

/**
 * A signed plain-number delta, always 2 dp, explicit `+` for gains:
 * `formatSignedDelta(1.25)` → `"+1,25"`, `-50` → `"-50,00"`, `0` → `"0,00"`.
 * Returns {@link EM_DASH} for absent/non-finite values.
 */
export function formatSignedDelta(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return normalizeSpaces(formatters().signedDelta.format(withoutNegativeZero(value)));
}

/** ISO timestamp → localised date + time (Vienna), or {@link EM_DASH} when absent/invalid. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? EM_DASH : formatters().dateTime.format(date);
}

/** ISO timestamp → localised date (Vienna), or {@link EM_DASH} when absent/invalid. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? EM_DASH : formatters().date.format(date);
}
