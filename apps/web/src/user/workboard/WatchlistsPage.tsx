import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { Badge, Button, Field, Input, Page, PageHead, Surface, SurfaceBody } from '../../ui/origin';
import { AudiencePicker } from '../components/AudiencePicker';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { useCreateIntent } from '../components/useCreateIntent';
import { CREATE_INTENT } from '../routeParams';
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
  const createFormRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<WatchlistSummary | null>(null);
  const [sharing, setSharing] = useState<WatchlistSummary | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: WATCHLISTS_QUERY_KEY,
    queryFn: ({ signal }) => listWatchlists(signal),
  });

  // Creation is intentionally an inline, immediately visible form on this
  // compact page, so the global intent starts that flow by moving focus to its
  // name field — held until the list has loaded, because the form is not
  // mounted before that.
  useCreateIntent(
    CREATE_INTENT.watchlist,
    () => createFormRef.current?.querySelector<HTMLInputElement>('#watchlist-name')?.focus(),
    data !== undefined,
  );

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
      <Page className="bt-phone-surface bt-workboard-family bt-watchlists-page">
        <PageHead title={t('watchlists.title')} />
        <Skeleton height="h-24" />
      </Page>
    );
  }
  if (isError || !data) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-watchlists-page">
        <PageHead title={t('watchlists.title')} />
        <Alert tone="error">{t('watchlists.loadError')}</Alert>
        <div>
          <Button onClick={() => void refetch()}>{t('common.retry')}</Button>
        </div>
      </Page>
    );
  }

  return (
    <Page className="bt-phone-surface bt-workboard-family bt-watchlists-page">
      <PageHead title={t('watchlists.title')} />

      <Surface className="bt-watchlist-create" tone="quiet">
        <SurfaceBody>
          <form
            ref={createFormRef}
            className="bt-watchlist-create__form"
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
        </SurfaceBody>
      </Surface>
      {nameError ? <Alert tone="error">{nameError}</Alert> : null}

      {data.watchlists.length === 0 ? (
        <EmptyState title={t('watchlists.empty')} description={t('watchlists.subtitle')} />
      ) : (
        <ul className="bt-surface bt-data-list">
          {data.watchlists.map((w) => (
            <li className="bt-data-row bt-watchlist-row" key={w.id}>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link
                    className="bt-row-title bt-link min-w-0 break-words"
                    to={`/assets/watchlists/${w.id}`}
                  >
                    {w.name}
                  </Link>
                  {w.isDefault ? <Badge>{t('watchlists.defaultBadge')}</Badge> : null}
                  <span className="bt-meta">
                    {w.itemCount === 1
                      ? t('watchlists.itemsOne')
                      : t('watchlists.itemsOther', { count: w.itemCount })}
                  </span>
                </div>
                {w.isDefault ? (
                  <span className="bt-meta" id={`watchlist-default-reason-${w.id}`}>
                    {t('watchlists.defaultLockedReason')}
                  </span>
                ) : null}
              </div>
              <div className="bt-watchlist-row__actions flex flex-wrap items-center gap-2">
                {!paranoid ? (
                  <Button onClick={() => setSharing(w)} size="sm">
                    {t('sharing.shareButton')}
                  </Button>
                ) : null}
                {w.isDefault ? (
                  <>
                    <Button
                      aria-disabled="true"
                      aria-describedby={`watchlist-default-reason-${w.id}`}
                      onClick={() => undefined}
                      size="sm"
                    >
                      {t('watchlists.rename')}
                    </Button>
                    <Button
                      aria-disabled="true"
                      aria-describedby={`watchlist-default-reason-${w.id}`}
                      onClick={() => undefined}
                      size="sm"
                      variant="danger"
                    >
                      {t('watchlists.delete')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button onClick={() => setRenaming(w)} size="sm">
                      {t('watchlists.rename')}
                    </Button>
                    <Button
                      onClick={() => {
                        // Name the list in the prompt: the browser dialog carries
                        // no context of its own, so "Delete this watchlist?" next
                        // to a row of similar rows is a coin flip.
                        if (window.confirm(t('watchlists.deleteConfirm', { name: w.name })))
                          remove.mutate(w.id);
                      }}
                      size="sm"
                      variant="danger"
                    >
                      {t('watchlists.delete')}
                    </Button>
                  </>
                )}
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
    </Page>
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
    <Dialog phoneSheet title={t('watchlists.renameTitle')} onClose={onClose}>
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
        <div className="flex flex-wrap justify-end gap-2">
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
