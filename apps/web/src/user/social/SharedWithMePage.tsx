import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type {
  SharedConglomerateSummary,
  SharedPortfolioSummary,
  SharedWatchlistSummary,
} from '@bettertrack/contracts';

import { listSharedWithMe } from '../../lib/socialApi';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Alert } from '../components/ui';

const SHARED_STALE_MS = 30_000;

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{children}</h3>
  );
}

function PortfolioRow({ p }: { p: SharedPortfolioSummary }) {
  return (
    <li className="py-3">
      <Link
        to={`/social/shared-with-me/${p.portfolioId}`}
        className="flex items-center justify-between gap-3 rounded px-1 py-1 hover:bg-neutral-900/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-100">{p.name}</p>
          <p className="truncate text-xs text-neutral-500">{p.owner.username}</p>
        </div>
        <MoneyText amount={p.totalValueEur} className="shrink-0 text-sm font-medium" />
      </Link>
    </li>
  );
}

function ConglomerateRow({ c }: { c: SharedConglomerateSummary }) {
  return (
    <li className="py-3">
      <Link
        to={`/social/shared-with-me/conglomerates/${c.conglomerateId}`}
        className="flex items-center justify-between gap-3 rounded px-1 py-1 hover:bg-neutral-900/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-100">{c.name}</p>
          <p className="truncate text-xs text-neutral-500">{c.owner.username}</p>
        </div>
        <span className="shrink-0 text-xs text-neutral-500">
          {c.positionCount} {c.positionCount === 1 ? 'asset' : 'assets'}
        </span>
      </Link>
    </li>
  );
}

function WatchlistRow({ w }: { w: SharedWatchlistSummary }) {
  return (
    <li className="py-3">
      <Link
        to={`/social/shared-with-me/watchlists/${w.owner.id}`}
        className="flex items-center justify-between gap-3 rounded px-1 py-1 hover:bg-neutral-900/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-100">
            {w.owner.username}&rsquo;s watchlist
          </p>
        </div>
        <span className="shrink-0 text-xs text-neutral-500">
          {w.itemCount} {w.itemCount === 1 ? 'asset' : 'assets'}
        </span>
      </Link>
    </li>
  );
}

/**
 * Shared With Me (PROJECTPLAN.md §6.9 point 4, §13.2 V2-P9) — everything the
 * caller's friends currently share: portfolios, conglomerates and watchlists.
 * Each row opens a read-only view.
 */
export function SharedWithMePage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['social', 'shared'],
    queryFn: ({ signal }) => listSharedWithMe(signal),
    staleTime: SHARED_STALE_MS,
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-16" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">Could not load shared items. Please refresh the page.</Alert>;
  }

  const nothing =
    data.portfolios.length === 0 && data.conglomerates.length === 0 && data.watchlists.length === 0;

  if (nothing) {
    return (
      <EmptyState
        title="Nothing shared with you yet"
        description="When a friend turns sharing on for a portfolio, conglomerate or watchlist, it appears here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {data.portfolios.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Portfolios</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.portfolios.map((p) => (
              <PortfolioRow key={p.portfolioId} p={p} />
            ))}
          </ul>
        </section>
      ) : null}

      {data.conglomerates.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Conglomerates</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.conglomerates.map((c) => (
              <ConglomerateRow key={c.conglomerateId} c={c} />
            ))}
          </ul>
        </section>
      ) : null}

      {data.watchlists.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Watchlists</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.watchlists.map((w) => (
              <WatchlistRow key={w.owner.id} w={w} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
