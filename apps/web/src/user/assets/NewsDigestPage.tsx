import { useQuery } from '@tanstack/react-query';

import type { NewsDigestGroup } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getNewsDigest, PORTFOLIO_NEWS_DIGEST_QUERY_KEY } from '../../lib/marketIntelApi';
import { EmptyState, Skeleton } from '../../ui';
import { Button } from '../../ui/origin';
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
      className="flex flex-col gap-3 bt-panel bt-panel--pad"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/assets/${encodeURIComponent(group.assetId)}`}
          className="rounded font-mono text-sm font-semibold hover:underline"
        >
          {group.symbol}
        </Link>
        <span className="truncate text-sm bt-muted">{group.name}</span>
        {group.held ? (
          <span className="bt-badge bt-badge--pos px-2 py-0.5 text-[0.65rem] uppercase tracking-wide">
            {t('assets.news.held')}
          </span>
        ) : null}
        {group.watched ? (
          <span className="bt-badge bt-badge--blue px-2 py-0.5 text-[0.65rem] uppercase tracking-wide">
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
 * as the per-asset feeds. Each group's feed is compact + expandable per the
 * anti-bloat rule.
 *
 * The destination itself disappears when the arc is unconfigured (the section
 * nav and the ⌘K registry both gate on `capabilities.marketIntel`), so this
 * page is only reachable by direct URL then — and it says so: `available:
 * false` renders an explicit unavailable state, NEVER the "no headlines yet"
 * empty state, which would misreport a deploy-level kill-switch as a quiet news
 * day.
 */
export function NewsDigestPage() {
  const t = useT();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: PORTFOLIO_NEWS_DIGEST_QUERY_KEY,
    queryFn: ({ signal }) => getNewsDigest(signal),
    staleTime: NEWS_DIGEST_STALE_MS,
  });

  const unavailable = data !== undefined && !data.available;
  const groups = data?.available ? data.groups : [];
  // The server caps the per-request provider fan-out (§5.3), so a book past that
  // budget yields a digest covering only part of it. Say so on a single line —
  // a partial digest rendered as complete reads as "nothing else happened".
  const truncated = data?.available === true && data.truncated === true;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('assets.news.title')}</h1>
        <p className="mt-1 text-sm bt-muted">{t('assets.news.subtitle')}</p>
      </div>

      <section aria-busy={isLoading} aria-label={t('assets.news.title')}>
        {isLoading ? (
          <>
            <span aria-label={t('common.loading')} className="sr-only" role="status">
              {t('common.loading')}
            </span>
            <div className="flex flex-col gap-3">
              <Skeleton height="h-28" />
              <Skeleton height="h-28" />
              <Skeleton height="h-28" />
            </div>
          </>
        ) : isError ? (
          <div className="flex flex-col items-start gap-2">
            <Alert tone="error">{t('assets.news.loadError')}</Alert>
            <Button onClick={() => void refetch()}>{t('common.retry')}</Button>
          </div>
        ) : unavailable ? (
          <EmptyState
            icon="🚫"
            title={t('assets.news.unavailableTitle')}
            description={t('assets.news.unavailableDescription')}
          />
        ) : groups.length === 0 ? (
          <EmptyState
            icon="📰"
            title={t('assets.news.emptyTitle')}
            description={t('assets.news.emptyDescription')}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {truncated ? <p className="bt-meta">{t('assets.news.truncated')}</p> : null}
            {groups.map((g) => (
              <NewsGroupCard key={g.assetId} group={g} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
