import type {
  TaxCountry,
  TaxMode,
  TaxSettingsResponse,
  UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { cx } from '../components/ui';

/**
 * The shared tax-mode option list + picker (issue #636). One presentational
 * radio group used by BOTH the user-level "new portfolio default" surface and
 * the per-portfolio override control, so the two never drift. Which layer a
 * pick writes to is the caller's concern — the picker only reports the chosen
 * `UpdateTaxSettingsRequest`.
 */

/**
 * One selectable row of the picker: a plain mode, or `country_specific` with a
 * concrete country (V5-P4: the country picker is the option list itself — one
 * compact row per shipped country, no nested controls).
 */
export interface TaxOption {
  /** i18n key under `settings.taxes.mode.` */
  i18nKey: string;
  mode: TaxMode;
  country?: TaxCountry;
}

export const TAX_OPTIONS: readonly TaxOption[] = [
  { i18nKey: 'none', mode: 'none' },
  { i18nKey: 'manual_per_trade', mode: 'manual_per_trade' },
  { i18nKey: 'country_specific', mode: 'country_specific', country: 'AT' },
  { i18nKey: 'country_specific_de', mode: 'country_specific', country: 'DE' },
];

/**
 * Turn a picked option into the `mode ↔ country` body: a country option carries
 * its country, every other mode carries none — mirroring the contract's
 * refinement so the request is always valid on either endpoint.
 */
export function bodyForOption(option: TaxOption): UpdateTaxSettingsRequest {
  return option.country !== undefined
    ? { mode: option.mode, country: option.country }
    : { mode: option.mode };
}

/** Whether an option matches the given mode/country. */
export function isTaxOptionSelected(
  option: TaxOption,
  settings: TaxSettingsResponse | undefined,
): boolean {
  const mode = settings?.mode ?? 'none';
  if (option.mode !== mode) return false;
  if (option.country === undefined) return true;
  // Legacy country_specific rows without a country are Austria (V3-P4).
  return (settings?.country ?? 'AT') === option.country;
}

/** One selectable tax-option row: a radio + its label and explanation. */
function ModeOption({
  option,
  name,
  selected,
  disabled,
  onSelect,
}: {
  option: TaxOption;
  name: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 transition-colors',
        selected
          ? 'border-sky-500/60 bg-sky-500/5'
          : 'border-neutral-800 bg-neutral-900 hover:border-neutral-700',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name={name}
        value={option.country ?? option.mode}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 accent-sky-500"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-100">
          {t(`settings.taxes.mode.${option.i18nKey}.label`)}
        </span>
        <span className="text-xs leading-relaxed text-neutral-500">
          {t(`settings.taxes.mode.${option.i18nKey}.description`)}
        </span>
      </span>
    </label>
  );
}

/**
 * The tax-mode radio group. `value` is the currently-selected mode/country (the
 * user default on the defaults surface, the effective value on a portfolio's
 * override surface); `name` scopes the radio group so two pickers never collide.
 */
export function TaxModePicker({
  value,
  name,
  busy,
  ariaLabel,
  onSelect,
}: {
  value: TaxSettingsResponse | undefined;
  name: string;
  busy: boolean;
  ariaLabel: string;
  onSelect: (body: UpdateTaxSettingsRequest) => void;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-3">
      {TAX_OPTIONS.map((option) => {
        const selected = isTaxOptionSelected(option, value);
        return (
          <ModeOption
            key={option.i18nKey}
            option={option}
            name={name}
            selected={selected}
            disabled={busy}
            onSelect={() => {
              if (!selected && !busy) onSelect(bodyForOption(option));
            }}
          />
        );
      })}
    </div>
  );
}
