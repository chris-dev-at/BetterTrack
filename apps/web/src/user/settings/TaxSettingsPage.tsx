import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  TAX_MODES,
  type TaxMode,
  type TaxSettingsResponse,
  type UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getTaxSettings, updateTaxSettings } from '../../lib/settingsApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, cx } from '../components/ui';

const TAX_SETTINGS_KEY = ['settings', 'taxes'] as const;

/** The country a `country_specific` selection ships (V3-P4: Austria only, §13.3). */
const COUNTRY_SPECIFIC_COUNTRY = 'AT' as const;

/**
 * Turn a picked mode into the `PATCH /settings/taxes` body: `country_specific`
 * carries the (only shipped) country, every other mode carries none — mirroring
 * the contract's `mode ↔ country` refinement so the request is always valid.
 */
function bodyForMode(mode: TaxMode): UpdateTaxSettingsRequest {
  return mode === 'country_specific' ? { mode, country: COUNTRY_SPECIFIC_COUNTRY } : { mode };
}

/** One selectable tax-mode row: a radio + its label and explanation. */
function ModeOption({
  mode,
  selected,
  disabled,
  onSelect,
}: {
  mode: TaxMode;
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
        value={mode}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 accent-sky-500"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-100">
          {t(`settings.taxes.mode.${mode}.label`)}
        </span>
        <span className="text-xs leading-relaxed text-neutral-500">
          {t(`settings.taxes.mode.${mode}.description`)}
        </span>
      </span>
    </label>
  );
}

/**
 * Settings → Taxes (PROJECTPLAN.md §13.3 V3-P4). Picks the per-user tax mode
 * (`GET/PATCH /settings/taxes`): `none`, `manual_per_trade`, or `country_specific`
 * (Austria). The Austria option spells out the model it applies (27.5 % KESt,
 * moving-average cost basis, same-year loss offset with refund, hard Jan-1 reset,
 * no cross-year carry). Switching applies forward only — recorded rows keep the
 * tax frozen at their recording time (§16). All copy comes from the i18n layer.
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

  function selectMode(next: TaxMode) {
    if (next === mode || mutation.isPending) return;
    mutation.mutate(bodyForMode(next));
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
          {TAX_MODES.map((m) => (
            <ModeOption
              key={m}
              mode={m}
              selected={mode === m}
              disabled={mutation.isPending}
              onSelect={() => selectMode(m)}
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
