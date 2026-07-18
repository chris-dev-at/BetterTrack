import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type {
  TaxCountry,
  TaxMode,
  TaxSettingsResponse,
  UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getTaxSettings, updateTaxSettings } from '../../lib/settingsApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, cx } from '../components/ui';

const TAX_SETTINGS_KEY = ['settings', 'taxes'] as const;

/**
 * One selectable row of the picker: a plain mode, or `country_specific` with a
 * concrete country (V5-P4: the country picker is the option list itself — one
 * compact row per shipped country, no nested controls).
 */
interface TaxOption {
  /** i18n key under `settings.taxes.mode.` */
  i18nKey: string;
  mode: TaxMode;
  country?: TaxCountry;
}

const TAX_OPTIONS: readonly TaxOption[] = [
  { i18nKey: 'none', mode: 'none' },
  { i18nKey: 'manual_per_trade', mode: 'manual_per_trade' },
  { i18nKey: 'country_specific', mode: 'country_specific', country: 'AT' },
  { i18nKey: 'country_specific_de', mode: 'country_specific', country: 'DE' },
];

/**
 * Turn a picked option into the `PATCH /settings/taxes` body: a country option
 * carries its country, every other mode carries none — mirroring the
 * contract's `mode ↔ country` refinement so the request is always valid.
 */
function bodyForOption(option: TaxOption): UpdateTaxSettingsRequest {
  return option.country !== undefined
    ? { mode: option.mode, country: option.country }
    : { mode: option.mode };
}

/** Whether an option matches the saved settings. */
function isSelected(option: TaxOption, settings: TaxSettingsResponse | undefined): boolean {
  const mode = settings?.mode ?? 'none';
  if (option.mode !== mode) return false;
  if (option.country === undefined) return true;
  // Legacy country_specific rows without a country are Austria (V3-P4).
  return (settings?.country ?? 'AT') === option.country;
}

/** One selectable tax-option row: a radio + its label and explanation. */
function ModeOption({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: TaxOption;
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
        name="tax-mode"
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
 * Settings → Taxes (PROJECTPLAN.md §13.3 V3-P4; §13.5 V5-P4). Picks the
 * per-user tax mode (`GET/PATCH /settings/taxes`): `none`, `manual_per_trade`,
 * or `country_specific` — Austria (27.5 % KESt, moving-average basis, hard
 * Jan-1 reset) or Germany (25 % Abgeltungsteuer + Soli, FIFO lots,
 * Sparer-Pauschbetrag, dual carry-forward loss pots), each option spelling out
 * the model it applies. Switching applies forward only — recorded rows keep
 * the tax frozen at their recording time (§16). All copy comes from the i18n
 * layer.
 */
export function TaxSettingsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);

  const query = useQuery({
    queryKey: TAX_SETTINGS_KEY,
    queryFn: ({ signal }) => getTaxSettings(signal),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (body: UpdateTaxSettingsRequest) => updateTaxSettings(body),
    onSuccess: (res: TaxSettingsResponse) => {
      queryClient.setQueryData(TAX_SETTINGS_KEY, res);
      // The per-year report reads from the same settings; refresh it so a mode
      // switch is reflected without a manual reload.
      void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxYears'] });
      setError(false);
    },
    onError: () => setError(true),
  });

  const mode = query.data?.mode ?? 'none';

  function selectOption(option: TaxOption) {
    if (isSelected(option, query.data) || mutation.isPending) return;
    mutation.mutate(bodyForOption(option));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">{t('settings.taxes.title')}</h2>
        <p className="text-sm text-neutral-500">{t('settings.taxes.subtitle')}</p>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError ? (
        <EmptyState
          title={t('settings.taxes.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : (
        <div
          role="radiogroup"
          aria-label={t('settings.taxes.groupAria')}
          className="flex flex-col gap-3"
        >
          {TAX_OPTIONS.map((option) => (
            <ModeOption
              key={option.i18nKey}
              option={option}
              selected={isSelected(option, query.data)}
              disabled={mutation.isPending}
              onSelect={() => selectOption(option)}
            />
          ))}
          {error ? <Alert tone="error">{t('settings.taxes.saveError')}</Alert> : null}
          {mode !== 'none' ? (
            <Link
              to="/portfolio/tax"
              className="w-fit text-sm font-medium text-sky-400 hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {t('settings.taxes.reportLink')}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
