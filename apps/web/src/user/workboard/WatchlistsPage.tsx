import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { WatchlistSummary } from '@bettertrack/contracts';

import {
  WATCHLISTS_QUERY_KEY,
  createWatchlist,
  deleteWatchlist,
  listWatchlists,
  renameWatchlist,
} from '../../lib/workboardApi';
import { ApiError } from '../../lib/apiClient';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { Badge, Button, Field, Input, PageHead } from '../../ui/origin';
import { AudiencePicker } from '../components/AudiencePicker';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';

/**
 * Named watchlists (PROJECTPLAN.md §13.3 V3-P5): create / rename / delete lists,
 * with the default **General** list locked, and a per-list audience via the ONE
 * reusable AudiencePicker. The multiple-watchlists affordances go live here.
 */
export function WatchlistsPage() {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<WatchlistSummary | null>(null);
  const [sharing, setSharing] = useState<WatchlistSummary | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: WATCHLISTS_QUERY_KEY,
    queryFn: ({ signal }) => listWatchlists(signal),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: WATCHLISTS_QUERY_KEY });

  const create = useMutation({
    mutationFn: (n: string) => createWatchlist(n),
    onSuccess: () => {
      setName('');
      setNameError(null);
      void invalidate();
    },
    onError: (err) => {
      setNameError(
        err instanceof ApiError && err.code === 'WATCHLIST_NAME_TAKEN'
          ? t('watchlists.nameTaken')
          : t('watchlists.loadError'),
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteWatchlist(id),
    onSuccess: () => void invalidate(),
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-24" />
      </section>
    );
  }
  if (isError || !data) {
    return <Alert tone="error">{t('watchlists.loadError')}</Alert>;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHead title={t('watchlists.title')} />

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed) create.mutate(trimmed);
        }}
      >
        <Field className="flex-1" htmlFor="watchlist-name" label={t('watchlists.create')}>
          <Input
            id="watchlist-name"
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            placeholder={t('watchlists.namePlaceholder')}
            value={name}
          />
        </Field>
        <Button
          disabled={create.isPending || name.trim().length === 0}
          type="submit"
          variant="primary"
        >
          {t('watchlists.create')}
        </Button>
      </form>
      {nameError ? <Alert tone="error">{nameError}</Alert> : null}

      {data.watchlists.length === 0 ? (
        <EmptyState title={t('watchlists.empty')} description={t('watchlists.subtitle')} />
      ) : (
        <ul className="bt-panel bt-band">
          {data.watchlists.map((w) => (
            <li className="bt-band__row flex items-center justify-between gap-3" key={w.id}>
              <div className="flex items-center gap-2">
                <span className="bt-row-title">{w.name}</span>
                {w.isDefault ? <Badge>{t('watchlists.defaultBadge')}</Badge> : null}
                <span className="bt-meta">
                  {w.itemCount === 1
                    ? t('watchlists.itemsOne')
                    : t('watchlists.itemsOther', { count: w.itemCount })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {!paranoid ? (
                  <Button onClick={() => setSharing(w)} size="sm">
                    {t('sharing.shareButton')}
                  </Button>
                ) : null}
                {!w.isDefault ? (
                  <>
                    <Button onClick={() => setRenaming(w)} size="sm">
                      {t('watchlists.rename')}
                    </Button>
                    <Button
                      onClick={() => {
                        if (window.confirm(t('watchlists.deleteConfirm'))) remove.mutate(w.id);
                      }}
                      size="sm"
                      variant="danger"
                    >
                      {t('watchlists.delete')}
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {renaming ? (
        <RenameDialog
          watchlist={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            void invalidate();
          }}
        />
      ) : null}

      {sharing && !paranoid ? (
        <AudiencePicker
          kind="watchlist"
          subjectId={sharing.id}
          subjectLabel={sharing.name}
          onClose={() => setSharing(null)}
          onChanged={() => void invalidate()}
        />
      ) : null}
    </div>
  );
}

function RenameDialog({
  watchlist,
  onClose,
  onDone,
}: {
  watchlist: WatchlistSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(watchlist.name);
  const [error, setError] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (n: string) => renameWatchlist(watchlist.id, n),
    onSuccess: onDone,
    onError: (err) =>
      setError(
        err instanceof ApiError && err.code === 'WATCHLIST_NAME_TAKEN'
          ? t('watchlists.nameTaken')
          : t('watchlists.loadError'),
      ),
  });
  return (
    <Dialog title={t('watchlists.renameTitle')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed) rename.mutate(trimmed);
        }}
      >
        <Field htmlFor="watchlist-rename" label={t('watchlists.namePlaceholder')}>
          <Input
            id="watchlist-rename"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            value={name}
          />
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('sharing.cancel')}</Button>
          <Button
            disabled={rename.isPending || name.trim().length === 0}
            type="submit"
            variant="primary"
          >
            {t('sharing.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
