import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  WATCHLISTS_QUERY_KEY,
  WORKBOARD_QUERY_KEY,
  addToWorkboard,
  listWatchlists,
  listWorkboard,
  removeFromWorkboard,
} from '../../lib/workboardApi';
import { EmptyState, Skeleton } from '../../ui';
import { Button, Page, PageHead, Surface, SurfaceBody, SurfaceHead } from '../../ui/origin';
import { Alert } from '../components/ui';
import { AssetSearchBox } from '../components/AssetSearchBox';

const WATCHLIST_STALE_MS = 30_000;

/** One owned watchlist: its assets plus the existing add/remove operations. */
export function WatchlistDetailPage() {
  const t = useT();
  const { watchlistId = '' } = useParams<{ watchlistId: string }>();
  const queryClient = useQueryClient();
  const [addError, setAddError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const watchlistsQuery = useQuery({
    queryKey: WATCHLISTS_QUERY_KEY,
    queryFn: ({ signal }) => listWatchlists(signal),
    staleTime: WATCHLIST_STALE_MS,
  });
  const watchlist = watchlistsQuery.data?.watchlists.find((item) => item.id === watchlistId);

  const itemsQuery = useQuery({
    queryKey: [...WORKBOARD_QUERY_KEY, 'watchlist', watchlistId],
    queryFn: ({ signal }) => listWorkboard(watchlistId, signal),
    enabled: watchlist !== undefined,
    staleTime: WATCHLIST_STALE_MS,
    refetchOnMount: 'always',
  });

  const invalidateWatchlists = () =>
    queryClient.invalidateQueries({ queryKey: WORKBOARD_QUERY_KEY });

  const add = useMutation({
    mutationFn: (assetId: string) => addToWorkboard(assetId, watchlistId),
    onSuccess: () => {
      setAddError(null);
      void invalidateWatchlists();
    },
    onError: (error) => {
      setAddError(
        error instanceof ApiError && error.code === 'ALREADY_WATCHING'
          ? t('watchlists.alreadyAdded')
          : t('watchlists.addError'),
      );
    },
  });

  const remove = useMutation({
    mutationFn: (itemId: string) => removeFromWorkboard(itemId),
    onSuccess: () => {
      setRemoveError(null);
      void invalidateWatchlists();
    },
    onError: () => setRemoveError(t('workboard.overview.watchlist.removeError')),
  });

  if (watchlistsQuery.isLoading) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-watchlist-detail-page">
        <BackToWatchlists />
        <PageHead title={t('watchlists.title')} />
        <Skeleton height="h-24" />
      </Page>
    );
  }

  if (watchlistsQuery.isError) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-watchlist-detail-page">
        <BackToWatchlists />
        <PageHead title={t('watchlists.title')} />
        <Alert tone="error">{t('watchlists.loadError')}</Alert>
        <div>
          <Button onClick={() => void watchlistsQuery.refetch()}>{t('common.retry')}</Button>
        </div>
      </Page>
    );
  }

  if (!watchlist) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-watchlist-detail-page">
        <BackToWatchlists />
        <EmptyState
          title={t('watchlists.unavailableTitle')}
          description={t('common.unavailable')}
        />
      </Page>
    );
  }

  const watchlistTitle = <span className="break-words">{watchlist.name}</span>;

  if (itemsQuery.isLoading) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-watchlist-detail-page">
        <BackToWatchlists />
        <PageHead title={watchlistTitle} />
        <Skeleton height="h-24" />
      </Page>
    );
  }

  if (itemsQuery.isError || !itemsQuery.data) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-watchlist-detail-page">
        <BackToWatchlists />
        <PageHead title={watchlistTitle} />
        <Alert tone="error">{t('workboard.overview.watchlist.loadError')}</Alert>
        <Button onClick={() => void itemsQuery.refetch()}>{t('common.retry')}</Button>
      </Page>
    );
  }

  const itemCount = itemsQuery.data.items.length;

  return (
    <Page className="bt-phone-surface bt-workboard-family bt-watchlist-detail-page">
      <div className="flex min-w-0 flex-col">
        <BackToWatchlists />
        <PageHead
          title={watchlistTitle}
          sub={
            itemCount === 1
              ? t('watchlists.itemsOne')
              : t('watchlists.itemsOther', { count: itemCount })
          }
        />
      </div>

      <Surface className="bt-watchlist-add" tone="quiet">
        <SurfaceHead title={t('watchlists.addTo')} />
        <SurfaceBody>
          <AssetSearchBox
            onSelect={(item) => {
              setAddError(null);
              if (!add.isPending) add.mutate(item.id);
            }}
          />
          {addError ? <Alert tone="error">{addError}</Alert> : null}
        </SurfaceBody>
      </Surface>

      {removeError ? <Alert tone="error">{removeError}</Alert> : null}

      {itemCount === 0 ? (
        <EmptyState
          title={t('workboard.overview.watchlist.emptyTitle')}
          description={t('workboard.overview.watchlist.emptyDescription')}
        />
      ) : (
        <ul className="bt-surface bt-data-list min-w-0">
          {itemsQuery.data.items.map((item) => (
            <li className="bt-data-row bt-watchlist-detail-row" key={item.id}>
              <Link
                className="min-w-0 flex-1 rounded"
                to={`/assets/${item.assetId}`}
                aria-label={`${item.asset.symbol} · ${item.asset.name}`}
              >
                <span className="bt-row-title block break-words font-mono">
                  {item.asset.symbol}
                </span>
                <span className="bt-row-sub block break-words">{item.asset.name}</span>
              </Link>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:shrink-0 sm:justify-end">
                {item.asset.exchange ? (
                  <span className="bt-meta max-w-full truncate">{item.asset.exchange}</span>
                ) : null}
                <Button
                  aria-label={t('workboard.overview.watchlist.removeAriaLabel', {
                    symbol: item.asset.symbol,
                  })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(item.id)}
                  size="sm"
                  variant="danger"
                >
                  {t('common.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function BackToWatchlists() {
  const t = useT();
  return (
    <Link className="bt-link mb-2 w-fit text-sm" to="/assets/watchlists">
      {t('watchlists.backToAll')}
    </Link>
  );
}
