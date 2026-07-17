import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { cloneIdea } from '../../lib/ideasApi';
import { listSharedWithMe } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { Avatar } from '../components/Avatar';
import { Alert, Button } from '../components/ui';

/**
 * `/social/shared-with-me/ideas/:ideaId` — a friend's shared idea, READ-ONLY
 * (PROJECTPLAN.md §13.4 V4-P9). An idea's saved state is never mirrored to a
 * non-owner; the recipient sees only the public-safe pointer (name, owner, whether
 * a thesis exists) resolved from the enforcement-derived Shared-With-Me payload,
 * and a Clone action. Cloning goes through the ONE enforcement layer
 * (`POST /ideas/:id/clone`) and lands a byte-exact PRIVATE copy in their own Ideas,
 * which then opens in the Workboard. An idea that isn't (or is no longer) shared
 * with the caller simply isn't in the payload → a calm "not available" state.
 */
export function SharedIdeaPage() {
  const t = useT();
  const navigate = useNavigate();
  const { ideaId } = useParams<{ ideaId: string }>();

  const sharedQuery = useQuery({
    queryKey: ['social', 'shared-with-me'],
    queryFn: ({ signal }) => listSharedWithMe(signal),
    staleTime: 30_000,
  });

  const cloneMutation = useMutation({
    mutationFn: () => cloneIdea(ideaId!),
    onSuccess: (result) => {
      navigate(`/workboard/ideas/${result.idea.id}`);
    },
  });

  const backLink = (
    <Link to="/social/friends" className="text-sm text-neutral-500 hover:text-neutral-300">
      {t('social.sharedIdea.backLink')}
    </Link>
  );

  if (!ideaId) return null;

  if (sharedQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-40" />
      </div>
    );
  }

  if (sharedQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <Alert tone="error">{t('social.sharedIdea.loadError')}</Alert>
        <div>
          <Button variant="secondary" onClick={() => void sharedQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const idea = sharedQuery.data?.ideas.find((i) => i.ideaId === ideaId);

  if (!idea) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <EmptyState
          icon="🔒"
          title={t('social.sharedIdea.notAvailableTitle')}
          description={t('social.sharedIdea.notAvailableBody')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {backLink}

      <div className="flex items-center gap-3">
        <Avatar name={idea.owner.username} iconId={idea.owner.profileIcon} size="lg" />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-neutral-100">
            {idea.name}
          </h1>
          <p className="truncate text-sm text-neutral-500">
            {t('social.sharedIdea.ownerLine', { username: idea.owner.username })}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        {idea.hasThesis ? (
          <p className="text-sm text-neutral-300">{t('social.sharedIdea.hasThesis')}</p>
        ) : null}
        <p className="text-sm text-neutral-400">{t('social.sharedIdea.readOnlyNote')}</p>
        {cloneMutation.isError ? (
          <Alert tone="error">{t('social.sharedIdea.cloneError')}</Alert>
        ) : null}
        <div>
          <Button onClick={() => cloneMutation.mutate()} disabled={cloneMutation.isPending}>
            {cloneMutation.isPending
              ? t('social.sharedIdea.cloning')
              : t('social.sharedIdea.clone')}
          </Button>
        </div>
      </div>
    </div>
  );
}
