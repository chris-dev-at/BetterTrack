import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { TaxSettingsResponse, UpdateTaxSettingsRequest } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getTaxSettings, updateTaxSettings } from '../../lib/settingsApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert } from '../components/ui';
import { TaxModePicker } from './taxModePicker';

const TAX_SETTINGS_KEY = ['settings', 'taxes'] as const;

/**
 * Settings → New portfolio defaults (issue #636). The user-level DEFAULT layer
 * of the per-portfolio settings scoping cascade
 * (`effective = portfolio override ?? user default ?? system default`): what a
 * newly-created portfolio inherits, and the value every portfolio that has not
 * overridden tracks live. Editing a default here never rewrites recorded rows
 * (tax freezes at recording time, §16) and never forces an existing portfolio's
 * own override — each portfolio overrides/resets on its own tax surface.
 *
 * Currently one scopeable default (tax treatment); the section is structured so
 * future defaults (base currency, DRIP, …) drop in as sibling blocks.
 */
export function NewPortfolioDefaultsPage() {
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
      // Portfolios that inherit this default resolve it live (link semantics,
      // §16): refresh their resolved tax view and the per-year report.
      void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxSettings'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxYears'] });
      setError(false);
    },
    onError: () => setError(true),
  });

  const mode = query.data?.mode ?? 'none';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">
          {t('settings.newPortfolioDefaults.title')}
        </h2>
        <p className="text-sm text-neutral-500">{t('settings.newPortfolioDefaults.subtitle')}</p>
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
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-neutral-200">{t('settings.taxes.title')}</h3>
            <p className="text-xs text-neutral-500">
              {t('settings.newPortfolioDefaults.tax.hint')}
            </p>
          </div>
          <TaxModePicker
            value={query.data}
            name="new-portfolio-tax-default"
            busy={mutation.isPending}
            ariaLabel={t('settings.taxes.groupAria')}
            onSelect={(body) => mutation.mutate(body)}
          />
          {error ? <Alert tone="error">{t('settings.taxes.saveError')}</Alert> : null}
          {mode !== 'none' ? (
            <Link
              to="/portfolio/tax"
              className="w-fit text-sm font-medium text-sky-400 hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {t('settings.taxes.reportLink')}
            </Link>
          ) : null}
        </section>
      )}
    </div>
  );
}
