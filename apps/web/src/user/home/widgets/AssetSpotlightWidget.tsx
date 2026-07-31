import { lazy, Suspense, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { HistoryRange } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getAssetHistory, getAssetQuote } from '../../../lib/assetApi';
import { cx } from '../../../lib/cx';
import { formatSignedPercent } from '../../../lib/format';
import { MoneyText } from '../../../ui';
import { PriceChart } from '../../../ui/charts';
import type { PriceRange } from '../../../ui/charts';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps, WidgetSettingsExtraProps } from './types';

/**
 * Lazy on purpose. `AssetSearchBox` is the app's full search surface — it pulls
 * the conglomerate builder helpers, the transaction dialog and the search API
 * with it. Home is the landing route, and this picker only appears once a user
 * opens *this* widget's settings popover, so a static import would put all of
 * that in front of every session for a field almost nobody touches.
 */
const AssetSearchBox = lazy(() =>
  import('../../components/AssetSearchBox').then((m) => ({ default: m.AssetSearchBox })),
);

/**
 * One asset the user cares about: its price, today's move, and a small chart.
 *
 * Both reads use the asset page's exact keys — `['asset', id, 'quote']` and
 * `['asset', id, 'history', range]` — so spotlighting an asset the user also
 * opens costs no second request, and the quote here is the same one the asset
 * page shows rather than a near-duplicate fetched moments apart.
 *
 * The picked asset lives in the instance's settings as `assetId` plus an
 * `assetLabel` snapshot of the symbol. The label is a **display cache only**: it
 * lets the header and the loading state name the asset immediately (and keeps the
 * widget legible if the quote fetch fails), while `assetId` remains the sole
 * identity. A renamed or re-listed symbol therefore corrects itself as soon as a
 * quote arrives, because the live payload wins wherever both exist.
 */

/**
 * A useful subset of the chart's ranges. A tile this size cannot carry seven
 * toggles legibly, and the ones dropped (1D, 3M, 5Y) are the ones the asset page
 * exists for.
 */
const SPOTLIGHT_RANGES: readonly PriceRange[] = ['1W', '1M', '6M', '1Y'];

/** The chart's tokens use 'Max'; the contract uses 'MAX' (see PerformanceChartWidget). */
function toHistoryRange(range: PriceRange): HistoryRange {
  return range === 'Max' ? 'MAX' : (range as HistoryRange);
}

function asRange(value: string | undefined): PriceRange {
  return SPOTLIGHT_RANGES.includes(value as PriceRange) ? (value as PriceRange) : '1M';
}

export function AssetSpotlightWidget({ settings, onSettingsChange, size }: WidgetProps) {
  const t = useT();
  const range = asRange(settings.range);
  const assetId = settings.assetId ?? null;

  const quoteQuery = useQuery({
    queryKey: ['asset', assetId, 'quote'],
    queryFn: ({ signal }) => getAssetQuote(assetId!, signal),
    enabled: assetId !== null,
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ['asset', assetId, 'history', toHistoryRange(range)],
    queryFn: ({ signal }) => getAssetHistory(assetId!, toHistoryRange(range), signal),
    enabled: assetId !== null,
    staleTime: 60_000,
  });

  const series = useMemo(
    () =>
      (historyQuery.data?.points ?? []).map((point) => ({
        time: Math.floor(Date.parse(point.time) / 1000) as Time,
        value: point.close,
      })),
    [historyQuery.data],
  );

  if (assetId === null) {
    return (
      <Empty icon="search" title={t('home.widgets.assetSpotlight.unpicked')}>
        {t('home.widgets.assetSpotlight.unpickedHint')}
      </Empty>
    );
  }

  const quote = quoteQuery.data?.quote ?? null;
  // The live symbol wins; the stored label is the stand-in until it arrives.
  const label = settings.assetLabel ?? '';
  const pct = quote?.dayChangePct ?? null;

  return (
    <div>
      <p className="bt-home-spot__head">
        <Link className="bt-row-title bt-home-txn__link" to={`/assets/${assetId}`}>
          {label === '' ? t('home.widgets.assetSpotlight.unnamed') : label}
        </Link>
        {quote !== null ? (
          <span className="bt-home-spot__price">
            <MoneyText amount={quote.price} currency={quote.currency} unitPrice />
          </span>
        ) : null}
        {/* A day move is genuine polarity, so it earns the pos/neg palette. */}
        {pct !== null ? (
          <span className={cx('bt-num', pct > 0 ? 'bt-pos' : pct < 0 ? 'bt-neg' : 'bt-muted')}>
            {formatSignedPercent(pct)}
          </span>
        ) : null}
      </p>
      <div className="bt-chart">
        <PriceChart
          ariaLabel={t('home.widgets.assetSpotlight.ariaLabel', { name: label })}
          height={size === 'l' ? 220 : 160}
          loading={historyQuery.isLoading || historyQuery.isFetching}
          mode="area"
          onRangeChange={(next) => onSettingsChange({ range: next })}
          range={range}
          // The widget's own header owns the left of this row (owner).
          rangeAlign="end"
          ranges={SPOTLIGHT_RANGES}
          series={series}
          // History owns the plotted points and now carries their native
          // currency. Do not couple the accessible alternative to the separate
          // live-quote request: history can be useful while that request is
          // pending or unavailable, and PriceChart will still mask it in
          // discreet mode.
          valueCurrency={historyQuery.data?.currency}
          valueFormat="unitPrice"
        />
      </div>
    </div>
  );
}

/**
 * The asset picker: the app's own search box in picker mode, so the widget offers
 * the same catalog, the same debounce and the same result rows as `/search` and
 * the ⌘K palette rather than a bespoke lookup.
 */
export function AssetSpotlightSettings({ settings, onSettingsChange }: WidgetSettingsExtraProps) {
  const t = useT();

  return (
    <div className="bt-home-spot-pick">
      <p className="bt-label">{t('home.widgets.assetSpotlight.pickLabel')}</p>
      {settings.assetLabel !== undefined ? (
        <p className="bt-meta bt-home-spot-pick__current">
          {t('home.widgets.assetSpotlight.current', { name: settings.assetLabel })}
        </p>
      ) : null}
      <Suspense fallback={<SkeletonBlock height={72} />}>
        <AssetSearchBox
          onSelect={(item) => onSettingsChange({ assetId: item.id, assetLabel: item.symbol })}
          placeholder={t('home.widgets.assetSpotlight.searchPlaceholder')}
        />
      </Suspense>
    </div>
  );
}
