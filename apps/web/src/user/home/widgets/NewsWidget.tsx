import { useQuery } from '@tanstack/react-query';

import { useT } from '../../../i18n';
import { formatDateTime } from '../../../lib/format';
import { getNewsDigest, PORTFOLIO_NEWS_DIGEST_QUERY_KEY } from '../../../lib/marketIntelApi';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps } from './types';

/**
 * Headlines on the assets the user actually holds.
 *
 * The market-intel area already exposes a portfolio-level digest
 * (`GET /assets/portfolio/news-digest`) that aggregates held **and** watchlist
 * assets server-side, so this widget reuses that one request under its existing
 * `['portfolio','news-digest']` key — no per-asset fan-out, and no new endpoint.
 * Watchlist-only groups are filtered out here: the widget is about holdings.
 *
 * `available: false` is the global market-intel gate being off. Unlike the
 * portfolio page (which hides the whole block when unconfigured), a widget the
 * user deliberately placed must explain itself, so it renders a terse empty
 * state rather than a blank slot the user cannot account for.
 */

/** Assets surfaced at most, newest-group-first. */
const MAX_GROUPS = 6;
/** Headlines per asset — a home widget is a glance, not the digest page. */
const HEADLINES_PER_GROUP = 2;

export function NewsWidget({ size }: WidgetProps) {
  const t = useT();
  const digestQuery = useQuery({
    queryKey: PORTFOLIO_NEWS_DIGEST_QUERY_KEY,
    queryFn: ({ signal }) => getNewsDigest(signal),
    staleTime: 3_600_000,
  });

  if (digestQuery.isLoading) {
    return (
      <div className="bt-home-news">
        <SkeletonBlock height={38} />
        <SkeletonBlock height={38} />
      </div>
    );
  }

  if (digestQuery.isError || !digestQuery.data?.available) {
    return <Empty title={t('home.widgets.news.unavailable')} />;
  }

  const groups = digestQuery.data.groups
    .filter((group) => group.held && group.headlines.length > 0)
    .slice(0, size === 's' ? 3 : MAX_GROUPS);

  if (groups.length === 0) return <Empty title={t('home.widgets.news.empty')} />;

  return (
    <ul className="bt-band bt-home-news">
      {groups.map((group) => (
        <li className="bt-home-news__group" key={group.assetId}>
          <p className="bt-label bt-home-news__symbol" title={group.name}>
            {group.symbol}
          </p>
          <ul className="bt-home-news__items">
            {group.headlines.slice(0, HEADLINES_PER_GROUP).map((headline) => (
              <li key={headline.id}>
                <a
                  className="bt-home-news__link"
                  href={headline.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {headline.title}
                </a>
                <span className="bt-meta bt-home-news__meta">
                  {[
                    headline.publisher,
                    headline.publishedAt === null ? null : formatDateTime(headline.publishedAt),
                  ]
                    .filter((part) => part !== null && part !== '')
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
