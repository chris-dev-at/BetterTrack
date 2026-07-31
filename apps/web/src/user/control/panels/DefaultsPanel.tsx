import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { TaxSettingsResponse, UpdateTaxSettingsRequest } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Disclaimer, Skeleton } from '../../../ui';
import { Button } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { usePortfolioStore } from '../../portfolio/PortfolioStoreProvider';
import { PanelGroup, PanelHead, PanelNote, Row } from './panelKit';
import { TaxModeList } from './taxModeList';

const TAX_SETTINGS_KEY = ['settings', 'taxes'] as const;

/**
 * Control Center → Portfolio defaults (issue #636). The user-level DEFAULT layer
 * of the per-portfolio settings scoping cascade
 * (`effective = portfolio override ?? user default ?? system default`): what a
 * newly-created portfolio inherits, and the value every portfolio that has not
 * overridden tracks live. Editing a default here never rewrites recorded rows
 * (tax freezes at recording time, §16) and never forces an existing portfolio's
 * own override — each portfolio overrides/resets on its own tax surface.
 *
 * Currently one scopeable default (tax treatment); the panel is structured so
 * future defaults (base currency, DRIP, …) drop in as sibling groups. The modes
 * render through `./taxModeList` — the popup-scale presentation of the shared
 * picker's option set, importing its option list, selection test and request
 * shaping so the contract cannot drift from the page-scale control.
 */
export function DefaultsPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const store = usePortfolioStore();
  const [error, setError] = useState(false);

  const query = useQuery({
    queryKey: TAX_SETTINGS_KEY,
    queryFn: ({ signal }) => store.getTaxSettings(signal),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (body: UpdateTaxSettingsRequest) => store.updateTaxSettings(body),
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
    <div className="bt-cc-panel">
      <PanelHead title={t('control.portfolioDefaults')} />

      {query.isPending ? (
        <PanelGroup label={t('settings.taxes.title')}>
          <Row stack>
            <Skeleton height="h-16" />
          </Row>
        </PanelGroup>
      ) : query.isError ? (
        <PanelGroup label={t('settings.taxes.title')}>
          <Row stack>
            <PanelNote>{t('settings.taxes.loadError.title')}</PanelNote>
            <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
          </Row>
        </PanelGroup>
      ) : (
        <>
          <PanelGroup label={t('settings.taxes.title')}>
            {/* Owner-mandated (#636): the inheritance semantics stay spelled out —
                effective = portfolio override ?? user default ?? system default. */}
            <Row hint={t('settings.newPortfolioDefaults.tax.hint')} stack />
            <TaxModeList
              ariaLabel={t('settings.taxes.groupAria')}
              busy={mutation.isPending}
              name="new-portfolio-tax-default"
              onSelect={(body) => mutation.mutate(body)}
              value={query.data}
            />
            {error ? (
              <Row stack>
                <Alert tone="error">{t('settings.taxes.saveError')}</Alert>
              </Row>
            ) : null}
            {mode !== 'none' ? (
              <Row>
                <Link className="bt-link" to="/portfolio/tax">
                  {t('settings.taxes.reportLink')}
                </Link>
              </Row>
            ) : null}
          </PanelGroup>

          {/* Owner-mandated liability framing (#635): keep the wording as decided. */}
          <Disclaimer>{t('settings.taxes.disclaimer')}</Disclaimer>
        </>
      )}
    </div>
  );
}
