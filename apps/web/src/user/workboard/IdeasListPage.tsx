import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { Idea, ShareAudience } from '@bettertrack/contracts';

import { deleteIdea, listIdeas } from '../../lib/ideasApi';
import { listMyShared } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { AudiencePicker } from '../components/AudiencePicker';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';

const IDEAS_KEY = ['ideas'] as const;
const MY_SHARED_KEY = ['social', 'my-shared'] as const;

/** The per-idea "who can see this" chip, read off the single audience model. */
function AudienceBadge({
  audience,
  friendCount,
}: {
  audience: ShareAudience;
  friendCount: number;
}) {
  const t = useT();
  const label =
    audience === 'specific_friends' && friendCount > 0
      ? `${t('sharing.badge.specific_friends')} · ${friendCount}`
      : t(`sharing.badge.${audience}`);
  const tone =
    audience === 'private'
      ? 'border-neutral-700 text-neutral-400'
      : audience === 'public_link'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : 'border-sky-500/40 bg-sky-500/10 text-sky-200';
  return (
    <span className={cx('rounded-full border px-2 py-0.5 text-xs font-medium', tone)}>{label}</span>
  );
}

function DeleteIdeaDialog({
  name,
  onConfirm,
  onClose,
  pending,
  error,
}: {
  name: string;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error: boolean;
}) {
  const t = useT();
  return (
    <Dialog title={t('workboard.ideas.list.deleteTitle')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">{t('workboard.ideas.list.deleteBody', { name })}</p>
        {error ? <Alert tone="error">{t('workboard.ideas.list.deleteError')}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={pending}
            className="bg-red-700 hover:bg-red-600 disabled:bg-red-900"
          >
            {t('common.delete')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function IdeaRow({
  idea,
  audience,
  friendCount,
  onShare,
  onDelete,
}: {
  idea: Idea;
  audience: ShareAudience;
  friendCount: number;
  onShare: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium text-neutral-100">{idea.name}</span>
        <p className="truncate text-xs text-neutral-500">
          {idea.thesis ?? t('workboard.ideas.list.thesisNone')}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <AudienceBadge audience={audience} friendCount={friendCount} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link to={`/workboard/ideas/${idea.id}`}>
          <Button variant="secondary">{t('workboard.ideas.list.open')}</Button>
        </Link>
        <Button variant="secondary" onClick={onShare}>
          {t('workboard.ideas.list.share')}
        </Button>
        <Button variant="secondary" onClick={onDelete} className="text-red-300 hover:text-red-200">
          {t('common.delete')}
        </Button>
      </div>
    </li>
  );
}

/**
 * `/workboard/ideas` — the Ideas list (PROJECTPLAN.md §13.4 V4-P9): every saved
 * Workboard analysis the caller owns, each reopenable exactly as saved, shareable
 * through the reusable AudiencePicker (the ONE audience model), and deletable. The
 * per-idea audience is read off `GET /social/my-shared` so it never disagrees with
 * what is actually shared.
 */
export function IdeasListPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [picker, setPicker] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Idea | null>(null);

  const ideasQuery = useQuery({
    queryKey: IDEAS_KEY,
    queryFn: ({ signal }) => listIdeas(signal),
  });
  const mySharedQuery = useQuery({
    queryKey: MY_SHARED_KEY,
    queryFn: ({ signal }) => listMyShared(signal),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteIdea(id),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: IDEAS_KEY });
      void queryClient.invalidateQueries({ queryKey: MY_SHARED_KEY });
    },
  });

  if (ideasQuery.isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (ideasQuery.isError || !ideasQuery.data) {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="error">{t('workboard.ideas.list.loadError')}</Alert>
        <div>
          <Button variant="secondary" onClick={() => void ideasQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const ideas = ideasQuery.data.ideas;
  const audienceById = new Map(
    (mySharedQuery.data?.ideas ?? []).map((i) => [i.ideaId, i] as const),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">
          {t('workboard.ideas.list.title')}
        </h2>
        <p className="text-sm text-neutral-500">{t('workboard.ideas.list.subtitle')}</p>
      </div>

      {ideas.length === 0 ? (
        <EmptyState
          icon="💡"
          title={t('workboard.ideas.list.emptyTitle')}
          description={t('workboard.ideas.list.emptyBody')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {ideas.map((idea) => {
            const shared = audienceById.get(idea.id);
            return (
              <IdeaRow
                key={idea.id}
                idea={idea}
                audience={shared?.audience ?? 'private'}
                friendCount={shared?.friendCount ?? 0}
                onShare={() => setPicker({ id: idea.id, name: idea.name })}
                onDelete={() => setDeleteTarget(idea)}
              />
            );
          })}
        </ul>
      )}

      {picker ? (
        <AudiencePicker
          kind="idea"
          subjectId={picker.id}
          subjectLabel={picker.name}
          onClose={() => setPicker(null)}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: MY_SHARED_KEY })}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteIdeaDialog
          name={deleteTarget.name}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          onClose={() => (deleteMutation.isPending ? undefined : setDeleteTarget(null))}
          pending={deleteMutation.isPending}
          error={deleteMutation.isError}
        />
      ) : null}
    </div>
  );
}
