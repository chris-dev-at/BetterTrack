import { useQuery } from '@tanstack/react-query';

import type { NewsDigestGroup } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getNewsDigest, PORTFOLIO_NEWS_DIGEST_QUERY_KEY } from '../../lib/marketIntelApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert } from '../components/ui';
import { Link } from 'react-router-dom';

import { NewsHeadlineList } from './newsFeed';

/** The digest refetches on a gentle cadence so fresh headlines surface. */
const NEWS_DIGEST_STALE_MS = 15 * 60_000;

/** One asset's news group: identity + held/watched chips + its headline feed. */
function NewsGroupCard({ group }: { group: NewsDigestGroup }) {
  const t = useT();
  return (
    <section
      aria-label={t('assets.news.groupAria', { symbol: group.symbol })}
      className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/assets/${encodeURIComponent(group.assetId)}`}
          className="rounded font-mono text-sm font-semibold text-neutral-100 hover:text-sky-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {group.symbol}
        </Link>
        <span className="truncate text-sm text-neutral-400">{group.name}</span>
        {group.held ? (
          <span className="inline-flex items-center rounded-full bg-emerald-950/40 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-800/60">
            {t('assets.news.held')}
          </span>
        ) : null}
        {group.watched ? (
          <span className="inline-flex items-center rounded-full bg-sky-950/40 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-sky-300 ring-1 ring-sky-800/60">
            {t('assets.news.watched')}
          </span>
        ) : null}
      </div>
      <NewsHeadlineList headlines={group.headlines} />
    </section>
  );
}

/**
 * `/assets/news` — the portfolio news digest (PROJECTPLAN.md §13.5 V5-P5, arc
 * c). Aggregates recent headlines across the caller's held + watchlist assets,
 * grouped per asset and newest-first, over the same `MARKET_INTEL_ENABLED` gate
 * as the per-asset feeds. When the arc is unconfigured (or the provider serves
 * no news) the endpoint returns the "unconfigured" shape and this view shows a
 * calm empty state — no news content renders anywhere (regression-guarded). Each
 * group's feed is compact + expandable per the anti-bloat rule.
 */
export function NewsDigestPage() {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: PORTFOLIO_NEWS_DIGEST_QUERY_KEY,
    queryFn: ({ signal }) => getNewsDigest(signal),
    staleTime: NEWS_DIGEST_STALE_MS,
  });

  const groups = data?.available ? data.groups : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t('assets.news.title')}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">{t('assets.news.subtitle')}</p>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton height="h-28" />
          <Skeleton height="h-28" />
          <Skeleton height="h-28" />
        </div>
      ) : isError ? (
        <Alert tone="error">{t('assets.news.loadError')}</Alert>
      ) : groups.length === 0 ? (
        <EmptyState
          icon="📰"
          title={t('assets.news.emptyTitle')}
          description={t('assets.news.emptyDescription')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <NewsGroupCard key={g.assetId} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}
