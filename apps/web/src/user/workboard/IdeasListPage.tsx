import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { Idea, ShareAudience } from '@bettertrack/contracts';

import { deleteIdea, listIdeas } from '../../lib/ideasApi';
import { listMyShared } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { Badge, Button, PageHead, type BadgeTone } from '../../ui/origin';
import { AudiencePicker } from '../components/AudiencePicker';
import { AsyncReadState } from '../components/AsyncReadState';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';

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
  const tone: BadgeTone =
    audience === 'private' ? 'neutral' : audience === 'public_link' ? 'gold' : 'blue';
  return <Badge tone={tone}>{label}</Badge>;
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
    <Dialog phoneSheet title={t('workboard.ideas.list.deleteTitle')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="bt-soft">{t('workboard.ideas.list.deleteBody', { name })}</p>
        {error ? <Alert tone="error">{t('workboard.ideas.list.deleteError')}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={pending} onClick={onConfirm} variant="danger">
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
  sharingAllowed,
}: {
  idea: Idea;
  audience: ShareAudience;
  friendCount: number;
  onShare: () => void;
  onDelete: () => void;
  sharingAllowed: boolean;
}) {
  const t = useT();
  return (
    <li className="bt-band__row bt-idea-row flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="bt-row-title truncate">{idea.name}</span>
        <p className="bt-row-sub truncate">{idea.thesis ?? t('workboard.ideas.list.thesisNone')}</p>
        {sharingAllowed ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <AudienceBadge audience={audience} friendCount={friendCount} />
          </div>
        ) : null}
      </div>
      <div className="bt-idea-row__actions flex shrink-0 flex-wrap items-center gap-2">
        <Link to={`/workbench/ideas/${idea.id}`}>
          <Button size="sm">{t('workboard.ideas.list.open')}</Button>
        </Link>
        {sharingAllowed ? (
          <Button onClick={onShare} size="sm">
            {t('workboard.ideas.list.share')}
          </Button>
        ) : null}
        <Button onClick={onDelete} size="sm" variant="danger">
          {t('common.delete')}
        </Button>
      </div>
    </li>
  );
}

/**
 * `/workbench/ideas` — the Ideas list (PROJECTPLAN.md §13.4 V4-P9): every saved
 * Workboard analysis the caller owns, each reopenable exactly as saved, shareable
 * through the reusable AudiencePicker (the ONE audience model), and deletable. The
 * per-idea audience is read off `GET /social/my-shared` so it never disagrees with
 * what is actually shared.
 */
export function IdeasListPage() {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
    enabled: !paranoid,
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
      <section className="bt-phone-surface bt-ideas-page flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (ideasQuery.isError || !ideasQuery.data) {
    return (
      <div className="bt-phone-surface bt-ideas-page flex flex-col gap-3">
        <Alert tone="error">{t('workboard.ideas.list.loadError')}</Alert>
        <div>
          <Button onClick={() => void ideasQuery.refetch()}>{t('common.retry')}</Button>
        </div>
      </div>
    );
  }

  const ideas = ideasQuery.data.ideas;
  const audienceById = new Map(
    (mySharedQuery.data?.ideas ?? []).map((i) => [i.ideaId, i] as const),
  );

  return (
    <div className="bt-phone-surface bt-ideas-page flex flex-col gap-6">
      <PageHead title={t('workboard.ideas.list.title')} />

      {!paranoid ? (
        <AsyncReadState
          loading={mySharedQuery.isLoading}
          error={mySharedQuery.error}
          errorLabel={t('workboard.ideas.list.loadError')}
          onRetry={() => void mySharedQuery.refetch()}
        />
      ) : null}

      {ideas.length === 0 ? (
        <EmptyState
          icon="💡"
          title={t('workboard.ideas.list.emptyTitle')}
          description={t('workboard.ideas.list.emptyBody')}
          cta={
            <Link to="/workbench/blueprints" className="rounded text-sm bt-link">
              {t('workboard.ideas.list.emptyCta')}
            </Link>
          }
        />
      ) : (
        <ul className="bt-panel bt-band">
          {ideas.map((idea) => {
            const shared = audienceById.get(idea.id);
            return (
              <IdeaRow
                key={idea.id}
                idea={idea}
                audience={shared?.audience ?? 'private'}
                friendCount={shared?.friendCount ?? 0}
                sharingAllowed={!paranoid}
                onShare={() => setPicker({ id: idea.id, name: idea.name })}
                onDelete={() => setDeleteTarget(idea)}
              />
            );
          })}
        </ul>
      )}

      {picker && !paranoid ? (
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
