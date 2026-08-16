import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { AnalyticsCompareKind } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { listConglomerates } from '../../../lib/conglomerateApi';
import { Button } from '../../../ui/origin';
import { AssetSearchBox } from '../../components/AssetSearchBox';
import { usePortfolioStore } from '../PortfolioStoreProvider';

/** A committed compare target: the contract kind + its id, plus a display label. */
export interface CompareTarget {
  kind: AnalyticsCompareKind;
  id: string;
  label: string;
}

/** The picker's active tab, including the `none` (no comparison) state. */
type PickerKind = 'none' | AnalyticsCompareKind;

/**
 * Compare-target picker (PROJECTPLAN.md §13.3 V3-P9). Overlay ANY benchmark on
 * the Analytics graph: a catalog asset/index via the local search box, another
 * of the user's portfolios, or one of their conglomerates (backtest-priced). The
 * committed target flows up via {@link onChange}; the server resolves + prices it
 * and echoes a `compare` series with side-by-side stats.
 */
export function CompareControl({
  value,
  onChange,
  currentPortfolioId,
}: {
  value: CompareTarget | null;
  onChange: (next: CompareTarget | null) => void;
  currentPortfolioId: string;
}) {
  const store = usePortfolioStore();
  const t = useT();
  const [kind, setKind] = useState<PickerKind>(value?.kind ?? 'none');

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    enabled: kind === 'portfolio',
    staleTime: 60_000,
  });
  const conglomeratesQuery = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
    enabled: kind === 'conglomerate',
    staleTime: 30_000,
  });

  // Comparing a portfolio against itself is meaningless — offer only the others.
  const otherPortfolios = (portfoliosQuery.data?.portfolios ?? []).filter(
    (p) => p.id !== currentPortfolioId,
  );
  const conglomerates = conglomeratesQuery.data?.conglomerates ?? [];

  function selectKind(next: PickerKind) {
    setKind(next);
    if (next === 'none') onChange(null);
  }

  const tabs: { kind: PickerKind; label: string }[] = [
    { kind: 'none', label: t('portfolio.analytics.compare.none') },
    { kind: 'asset', label: t('portfolio.analytics.compare.asset') },
    { kind: 'portfolio', label: t('portfolio.analytics.compare.portfolio') },
    { kind: 'conglomerate', label: t('portfolio.analytics.compare.conglomerate') },
  ];

  return (
    <div className="bt-analytics-compare">
      <div className="bt-analytics-compare__head">
        <span className="bt-label">{t('portfolio.analytics.compare.heading')}</span>
        {value ? (
          <span className="bt-meta">
            {t('portfolio.analytics.compare.current', { label: value.label })}
          </span>
        ) : null}
      </div>

      <div
        role="group"
        aria-label={t('portfolio.analytics.compare.heading')}
        className="bt-seg bt-analytics-compare__seg"
      >
        {tabs.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            aria-pressed={kind === tab.kind}
            onClick={() => selectKind(tab.kind)}
            className={cx(kind === tab.kind && 'is-active')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {kind === 'asset' ? (
        <AssetSearchBox
          placeholder={t('portfolio.analytics.compare.searchPlaceholder')}
          onSelect={(item) => onChange({ kind: 'asset', id: item.id, label: item.symbol })}
        />
      ) : null}

      {kind === 'portfolio' ? (
        <PickerSelect
          label={t('portfolio.analytics.compare.pickPortfolio')}
          placeholder={t('portfolio.analytics.compare.pickPortfolioPlaceholder')}
          emptyLabel={t('portfolio.analytics.compare.noPortfolios')}
          errorLabel={t('common.genericError')}
          loading={portfoliosQuery.isLoading}
          error={portfoliosQuery.isError}
          onRetry={() => void portfoliosQuery.refetch()}
          options={otherPortfolios.map((p) => ({ id: p.id, name: p.name }))}
          selectedId={value?.kind === 'portfolio' ? value.id : ''}
          onPick={(id, name) => onChange({ kind: 'portfolio', id, label: name })}
        />
      ) : null}

      {kind === 'conglomerate' ? (
        <PickerSelect
          label={t('portfolio.analytics.compare.pickConglomerate')}
          placeholder={t('portfolio.analytics.compare.pickConglomeratePlaceholder')}
          emptyLabel={t('portfolio.analytics.compare.noConglomerates')}
          errorLabel={t('common.genericError')}
          loading={conglomeratesQuery.isLoading}
          error={conglomeratesQuery.isError}
          onRetry={() => void conglomeratesQuery.refetch()}
          options={conglomerates.map((c) => ({ id: c.id, name: c.name }))}
          selectedId={value?.kind === 'conglomerate' ? value.id : ''}
          onPick={(id, name) => onChange({ kind: 'conglomerate', id, label: name })}
        />
      ) : null}
    </div>
  );
}

/** A labelled `<select>` over `{id,name}` options, with loading + error + empty states. */
function PickerSelect({
  label,
  placeholder,
  emptyLabel,
  errorLabel,
  loading,
  error,
  options,
  selectedId,
  onPick,
  onRetry,
}: {
  label: string;
  placeholder: string;
  emptyLabel: string;
  errorLabel: string;
  loading: boolean;
  error: boolean;
  options: { id: string; name: string }[];
  selectedId: string;
  onPick: (id: string, name: string) => void;
  onRetry: () => void;
}) {
  const t = useT();
  if (loading) {
    return <p className="bt-meta">{placeholder}</p>;
  }
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs bt-neg">{errorLabel}</p>
        <Button onClick={onRetry} size="sm">
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (options.length === 0) {
    return <p className="bt-meta">{emptyLabel}</p>;
  }
  return (
    <select
      aria-label={label}
      value={selectedId}
      onChange={(e) => {
        const picked = options.find((o) => o.id === e.target.value);
        if (picked) onPick(picked.id, picked.name);
      }}
      className="bt-select bt-analytics-compare__select"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
