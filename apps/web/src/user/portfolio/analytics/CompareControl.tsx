import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { AnalyticsCompareKind } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { listConglomerates } from '../../../lib/conglomerateApi';
import { listPortfolios } from '../../../lib/portfolioApi';
import { AssetSearchBox } from '../../components/AssetSearchBox';

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
  const t = useT();
  const [kind, setKind] = useState<PickerKind>(value?.kind ?? 'none');

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
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
    <div className="flex flex-col gap-3 rounded-lg bg-neutral-900/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {t('portfolio.analytics.compare.heading')}
        </span>
        {value ? (
          <span className="text-xs text-neutral-400">
            {t('portfolio.analytics.compare.current', { label: value.label })}
          </span>
        ) : null}
      </div>

      <div
        role="group"
        aria-label={t('portfolio.analytics.compare.heading')}
        className="inline-flex flex-wrap gap-0.5 self-start rounded-md bg-neutral-950 p-0.5 ring-1 ring-inset ring-neutral-800"
      >
        {tabs.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            aria-pressed={kind === tab.kind}
            onClick={() => selectKind(tab.kind)}
            className={cx(
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              kind === tab.kind
                ? 'bg-sky-600 text-white'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
            )}
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
}) {
  if (loading) {
    return <p className="text-xs text-neutral-500">{placeholder}</p>;
  }
  if (error) {
    return <p className="text-xs text-rose-400">{errorLabel}</p>;
  }
  if (options.length === 0) {
    return <p className="text-xs text-neutral-500">{emptyLabel}</p>;
  }
  return (
    <select
      aria-label={label}
      value={selectedId}
      onChange={(e) => {
        const picked = options.find((o) => o.id === e.target.value);
        if (picked) onPick(picked.id, picked.name);
      }}
      className={cx(
        'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
        'ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500',
      )}
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
