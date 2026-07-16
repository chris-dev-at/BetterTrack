import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import type { BacktestPreviewPosition } from '@bettertrack/contracts';

import { getConglomerate } from '../../lib/conglomerateApi';
import { getIdea } from '../../lib/ideasApi';
import { useT } from '../../i18n';
import { Skeleton } from '../../ui';
import { Alert, Button } from '../components/ui';
import { BacktestPanel, type BacktestParams } from './BacktestPanel';

/**
 * `/workboard/ideas/:ideaId` — reopen a saved idea in the Workboard EXACTLY as it
 * was saved (PROJECTPLAN.md §13.4 V4-P9): the basket (a conglomerate reference OR
 * an ad-hoc weighted set) is resolved back to positions and the backtest params
 * (range / benchmark / late-listing mode / rebalance schedule) seed the panel, so
 * a save → reopen roundtrip is deep-equal by contract. The thesis note is shown
 * above; the same panel carries a "Save as idea" action to re-save any tweaks.
 */
export function IdeaWorkboardPage() {
  const t = useT();
  const { ideaId } = useParams<{ ideaId: string }>();

  const ideaQuery = useQuery({
    queryKey: ['idea', ideaId],
    queryFn: ({ signal }) => getIdea(ideaId!, signal),
    enabled: !!ideaId,
  });

  const idea = ideaQuery.data?.idea;
  const source = idea?.state.source;

  // A conglomerate-sourced idea resolves its basket from the referenced
  // conglomerate; an ad-hoc idea carries the positions inline.
  const conglomerateId = source?.kind === 'conglomerate' ? source.conglomerateId : undefined;
  const conglomerateQuery = useQuery({
    queryKey: ['conglomerate', conglomerateId],
    queryFn: ({ signal }) => getConglomerate(conglomerateId!, signal),
    enabled: !!conglomerateId,
  });

  const backLink = (
    <Link to="/workboard/ideas" className="text-sm text-neutral-500 hover:text-neutral-300">
      {t('workboard.ideas.open.backLink')}
    </Link>
  );

  if (!ideaId) return null;

  if (ideaQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-40" />
      </div>
    );
  }

  if (ideaQuery.isError || !idea || !source) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <Alert tone="error">{t('workboard.ideas.open.loadError')}</Alert>
        <div>
          <Button variant="secondary" onClick={() => void ideaQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const initialParams: BacktestParams = {
    range: idea.state.range,
    benchmark: idea.state.benchmark,
    mode: idea.state.mode,
    rebalance: idea.state.rebalance,
  };

  let positions: BacktestPreviewPosition[] | null = null;
  if (source.kind === 'adhoc') {
    positions = source.positions.map((p) => ({ assetId: p.assetId, weight: p.weight }));
  } else if (conglomerateQuery.data) {
    positions = conglomerateQuery.data.positions
      .filter((p) => p.weightPct > 0)
      .map((p) => ({ assetId: p.assetId, weight: p.weightPct }));
  }

  return (
    <div className="flex flex-col gap-6">
      {backLink}

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{idea.name}</h1>
        {idea.thesis ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {t('workboard.ideas.open.thesisHeading')}
            </h2>
            <p className="whitespace-pre-wrap text-sm text-neutral-300">{idea.thesis}</p>
          </div>
        ) : null}
      </div>

      <section aria-labelledby="idea-backtest-heading" className="flex flex-col gap-3">
        <h2 id="idea-backtest-heading" className="text-base font-semibold text-neutral-200">
          {t('workboard.ideas.open.backtestHeading')}
        </h2>
        {source.kind === 'conglomerate' && conglomerateQuery.isLoading ? (
          <Skeleton height="h-40" />
        ) : source.kind === 'conglomerate' && conglomerateQuery.isError ? (
          <Alert tone="info">{t('workboard.ideas.open.conglomerateGone')}</Alert>
        ) : positions ? (
          <BacktestPanel positions={positions} source={source} initialParams={initialParams} />
        ) : null}
      </section>
    </div>
  );
}
