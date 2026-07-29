import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';

import type { WorkboardItem } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getAssetQuote } from '../../../lib/assetApi';
import { cx } from '../../../lib/cx';
import { formatSignedPercent } from '../../../lib/format';
import {
  listWatchlists,
  listWorkboard,
  WATCHLISTS_QUERY_KEY,
  WORKBOARD_QUERY_KEY,
} from '../../../lib/workboardApi';
import { MoneyText } from '../../../ui';
import { Empty, Field, Select, SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps, WidgetSettingsExtraProps } from './types';

/**
 * One named watchlist with live quotes.
 *
 * Both reads reuse the Workboard page's own keys: `['workboard', 'watchlists']`
 * for the list of lists and the bare `['workboard']` for the items. The items
 * endpoint can filter server-side by `watchlistId`, but this widget deliberately
 * fetches the *unfiltered* set the page already caches and narrows it here —
 * otherwise a board holding this widget and a visit to the Workboard would keep
 * two overlapping entries warm, and switching the picked list would refetch rows
 * the client already had. Quotes fan out under the asset page's
 * `['asset', id, 'quote']`, so a watched asset the user opens costs nothing extra.
 *
 * Unscoped: a watchlist is a user-level object with no portfolio dimension.
 */

/**
 * Rows — and therefore quote requests — at most. A watchlist can hold far more
 * than a glance widget should turn into parallel provider-backed fetches.
 */
const MAX_ROWS = 8;

/** No `refetchInterval` on purpose: see {@link WatchlistWidget}'s quote note. */
const QUOTE_STALE_MS = 60_000;

export function WatchlistWidget({ settings, size }: WidgetProps) {
  const t = useT();

  const listsQuery = useQuery({
    queryKey: WATCHLISTS_QUERY_KEY,
    queryFn: ({ signal }) => listWatchlists(signal),
    staleTime: 60_000,
  });
  const itemsQuery = useQuery({
    queryKey: WORKBOARD_QUERY_KEY,
    queryFn: ({ signal }) => listWorkboard(undefined, signal),
    staleTime: 30_000,
  });

  const lists = listsQuery.data?.watchlists ?? [];
  /**
   * The picked list, else the first one (General is returned first). A setting
   * naming a list that has since been deleted degrades to the first rather than
   * rendering an inexplicably empty widget — and the setting is left untouched,
   * exactly as `resolveScope` treats a vanished portfolio.
   */
  const active = lists.find((list) => list.id === settings.watchlistId) ?? lists[0] ?? null;

  const items = (itemsQuery.data?.items ?? [])
    .filter((item) => active !== null && item.watchlistId === active.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, size === 's' ? 5 : MAX_ROWS);

  const quotes = useQueries({
    queries: items.map((item) => ({
      queryKey: ['asset', item.assetId, 'quote'],
      queryFn: ({ signal }: { signal: AbortSignal }) => getAssetQuote(item.assetId, signal),
      staleTime: QUOTE_STALE_MS,
    })),
    combine: (results) => results.map((result) => result.data?.quote ?? null),
  });

  if (listsQuery.isLoading || itemsQuery.isLoading) return <SkeletonBlock height={130} />;
  if (active === null) return <Empty title={t('home.widgets.watchlist.noLists')} />;
  if (items.length === 0) {
    return <Empty title={t('home.widgets.watchlist.empty', { name: active.name })} />;
  }

  return (
    <ul className="bt-band">
      {items.map((item, index) => (
        <WatchRow item={item} key={item.id} quote={quotes[index] ?? null} />
      ))}
    </ul>
  );
}

function WatchRow({
  item,
  quote,
}: {
  item: WorkboardItem;
  quote: { price: number; currency: string; dayChangePct?: number | null } | null;
}) {
  const pct = quote?.dayChangePct ?? null;

  return (
    <li className="bt-home-row bt-home-row--split">
      <span className="bt-home-row__main">
        <Link className="bt-row-title bt-home-txn__link" to={`/assets/${item.assetId}`}>
          {item.asset.symbol}
        </Link>
        <span className="bt-row-sub bt-home-row__sub" title={item.asset.name}>
          {item.asset.name}
        </span>
      </span>
      <span className="bt-home-txn__figures">
        {quote === null ? (
          <SkeletonBlock height={14} width={64} />
        ) : (
          <span className="bt-num">
            <MoneyText amount={quote.price} currency={quote.currency} unitPrice />
          </span>
        )}
        {/* A day move is genuine polarity, so it earns the pos/neg palette. */}
        {pct !== null ? (
          <span
            className={cx('bt-meta bt-num', pct > 0 ? 'bt-pos' : pct < 0 ? 'bt-neg' : 'bt-muted')}
          >
            {formatSignedPercent(pct)}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Which watchlist the widget shows. Reads the same `['workboard','watchlists']`
 * entry the widget itself does, so opening the popover costs no request.
 */
export function WatchlistSettings({ settings, onSettingsChange }: WidgetSettingsExtraProps) {
  const t = useT();
  const fieldId = useId();
  const listsQuery = useQuery({
    queryKey: WATCHLISTS_QUERY_KEY,
    queryFn: ({ signal }) => listWatchlists(signal),
    staleTime: 60_000,
  });
  const lists = listsQuery.data?.watchlists ?? [];

  return (
    <Field htmlFor={fieldId} label={t('home.widgets.watchlist.listLabel')}>
      <Select
        disabled={lists.length === 0}
        id={fieldId}
        onChange={(event) => onSettingsChange({ watchlistId: event.target.value })}
        value={settings.watchlistId ?? lists[0]?.id ?? ''}
      >
        {lists.map((list) => (
          <option key={list.id} value={list.id}>
            {list.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
