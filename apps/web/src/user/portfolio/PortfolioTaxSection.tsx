import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  PortfolioTaxSettingsResponse,
  UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { EmptyState } from '../../ui';
import { Badge, Button, SkeletonBlock } from '../../ui/origin';
import { Alert } from '../components/ui';
import { TaxModePicker } from '../settings/taxModePicker';
import { portfolioTaxSettingsKey, taxModeLabelKey } from './portfolioTax';
import { usePortfolioStore } from './PortfolioStoreProvider';

/**
 * Portfolio → Settings → Tax (issue #636). The **configuration** half of one
 * portfolio's tax treatment, moved here out of the Tax tab: that tab reports, this
 * tab decides. It resolves the scoping cascade
 * (`effective = override ?? user default ?? system('none')`), states which mode is
 * in effect and — the part users get wrong — whether that is *inherited from the
 * account default* or *overridden for this portfolio*, then offers exactly the two
 * moves that exist: override it here, or fall back to the account default.
 *
 * Mutations, cache seeding and error handling are the Tax tab's, unchanged: the
 * mutation result seeds {@link portfolioTaxSettingsKey} directly and invalidates
 * the year report, whose numbers depend on the effective mode.
 *
 * The mode list itself is the shared {@link TaxModePicker}, reused as-is: it
 * carries the folded-away manual-default field and custom-rule builder, so
 * rebuilding it densely here would have quietly dropped both.
 */
export function PortfolioTaxSection({ portfolioId }: { portfolioId: string }) {
  const t = useT();
  const store = usePortfolioStore();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);

  const query = useQuery({
    queryKey: portfolioTaxSettingsKey(portfolioId),
    queryFn: ({ signal }) => store.getPortfolioTaxSettings(portfolioId, signal),
    staleTime: 30_000,
  });

  const applyResult = (res: PortfolioTaxSettingsResponse) => {
    queryClient.setQueryData(portfolioTaxSettingsKey(portfolioId), res);
    // The effective mode gates the report + drives freezing of new rows.
    void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxYears', portfolioId] });
    setError(false);
  };
  const overrideMutation = useMutation({
    mutationFn: (body: UpdateTaxSettingsRequest) =>
      store.setPortfolioTaxOverride(portfolioId, body),
    onSuccess: applyResult,
    onError: () => setError(true),
  });
  const resetMutation = useMutation({
    mutationFn: () => store.clearPortfolioTaxOverride(portfolioId),
    onSuccess: applyResult,
    onError: () => setError(true),
  });
  const busy = overrideMutation.isPending || resetMutation.isPending;

  if (query.isPending) return <SkeletonBlock height={96} />;
  if (query.isError || !query.data) {
    return (
      <EmptyState
        description={t('settings.retryHint')}
        title={t('portfolio.settings.tax.loadError')}
      />
    );
  }

  const overridden = query.data.source === 'portfolio';

  return (
    <div className="bt-settings-block">
      {/* What is in effect, and where it comes from — one dense row. */}
      <div className="bt-pftax__status">
        <span className="bt-pftax__mode">
          <span className="bt-label">{t('portfolio.settings.tax.modeLabel')}</span>
          <span className="bt-row-title">{t(taxModeLabelKey(query.data.effective))}</span>
        </span>
        <Badge tone={overridden ? 'blue' : 'neutral'}>
          {overridden
            ? t('portfolio.settings.tax.overridden')
            : t('portfolio.settings.tax.inheriting')}
        </Badge>
      </div>
      <p className="bt-meta">{t('portfolio.settings.tax.hint')}</p>

      <TaxModePicker
        ariaLabel={t('portfolio.settings.tax.pickerAriaLabel')}
        busy={busy}
        name={`portfolio-tax-${portfolioId}`}
        onSelect={(body) => overrideMutation.mutate(body)}
        value={query.data.effective}
      />

      {/* The one move the picker cannot express: go back to the account default. */}
      <div className="bt-pftax__foot">
        {overridden ? (
          <>
            <span className="bt-meta">{t('portfolio.settings.tax.resetHint')}</span>
            <Button disabled={busy} onClick={() => resetMutation.mutate()} size="sm">
              {t('portfolio.settings.tax.reset')}
            </Button>
          </>
        ) : (
          <>
            <span className="bt-meta">{t('portfolio.settings.tax.inheritedHint')}</span>
            <Link className="bt-link" to="/settings/taxes">
              {t('portfolio.settings.tax.editDefault')}
            </Link>
          </>
        )}
      </div>

      {error ? <Alert tone="error">{t('settings.taxes.saveError')}</Alert> : null}
    </div>
  );
}
