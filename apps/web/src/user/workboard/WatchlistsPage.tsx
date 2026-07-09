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
import { AudiencePicker } from '../components/AudiencePicker';
import { Dialog } from '../components/Dialog';
import { Alert, Button, TextField } from '../components/ui';

/**
 * Named watchlists (PROJECTPLAN.md §13.3 V3-P5): create / rename / delete lists,
 * with the default **General** list locked, and a per-list audience via the ONE
 * reusable AudiencePicker. The multiple-watchlists affordances go live here.
 */
export function WatchlistsPage() {
  const t = useT();
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
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">{t('watchlists.title')}</h2>
        <p className="text-sm text-neutral-500">{t('watchlists.subtitle')}</p>
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed) create.mutate(trimmed);
        }}
      >
        <div className="flex-1">
          <TextField
            label={t('watchlists.create')}
            placeholder={t('watchlists.namePlaceholder')}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
          />
        </div>
        <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
          {t('watchlists.create')}
        </Button>
      </form>
      {nameError ? <Alert tone="error">{nameError}</Alert> : null}

      {data.watchlists.length === 0 ? (
        <EmptyState title={t('watchlists.empty')} description={t('watchlists.subtitle')} />
      ) : (
        <ul className="divide-y divide-neutral-800">
          {data.watchlists.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-neutral-100">{w.name}</span>
                {w.isDefault ? (
                  <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
                    {t('watchlists.defaultBadge')}
                  </span>
                ) : null}
                <span className="text-xs text-neutral-500">
                  {w.itemCount === 1
                    ? t('watchlists.itemsOne')
                    : t('watchlists.itemsOther', { count: w.itemCount })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setSharing(w)}>
                  {t('sharing.shareButton')}
                </Button>
                {!w.isDefault ? (
                  <>
                    <Button variant="secondary" onClick={() => setRenaming(w)}>
                      {t('watchlists.rename')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (window.confirm(t('watchlists.deleteConfirm'))) remove.mutate(w.id);
                      }}
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

      {sharing ? (
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
        <TextField
          label={t('watchlists.namePlaceholder')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('sharing.cancel')}
          </Button>
          <Button type="submit" disabled={rename.isPending || name.trim().length === 0}>
            {t('sharing.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
