import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { listSharedWithMe } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Avatar } from '../components/Avatar';
import { Alert } from '../components/ui';
import {
  ActivityAlertToggle,
  SharedItemRow,
  groupSharedByPerson,
  kindCountSummary,
  type SharedPerson,
} from './SharedPeople';

const SHARED_STALE_MS = 30_000;
export const SHARED_WITH_ME_KEY = ['social', 'shared-with-me'] as const;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * One person who shares with me: a collapsible card. Collapsed shows who + a
 * "2 portfolios · 1 watchlist" kind-count summary; expanded lists every item they
 * share (read-only deep links) each with its activity-alert toggle.
 */
function PersonCard({ person, defaultOpen }: { person: SharedPerson; defaultOpen: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `shared-by-${person.owner.id}`;

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
      >
        <Avatar name={person.owner.username} size="md" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-neutral-100">
            {person.owner.username}
          </span>
          <span className="truncate text-xs text-neutral-500">{kindCountSummary(person, t)}</span>
        </span>
        <Chevron open={open} />
      </button>

      {open ? (
        <div id={panelId} className="flex flex-col gap-2 border-t border-neutral-800 p-3">
          {person.portfolios.map((p) => (
            <SharedItemRow
              key={p.portfolioId}
              kind="portfolio"
              subjectId={p.portfolioId}
              name={p.name}
              secondary={<MoneyText amount={p.totalValueEur} />}
              trailing={
                <ActivityAlertToggle
                  kind="portfolio"
                  subjectId={p.portfolioId}
                  enabled={p.activityAlertsEnabled}
                />
              }
            />
          ))}
          {person.conglomerates.map((c) => (
            <SharedItemRow
              key={c.conglomerateId}
              kind="conglomerate"
              subjectId={c.conglomerateId}
              name={c.name}
              secondary={t('social.item.positions', { count: c.positionCount })}
              trailing={
                <ActivityAlertToggle
                  kind="conglomerate"
                  subjectId={c.conglomerateId}
                  enabled={c.activityAlertsEnabled}
                />
              }
            />
          ))}
          {person.watchlists.map((w) => (
            <SharedItemRow
              key={w.watchlistId}
              kind="watchlist"
              subjectId={w.watchlistId}
              name={w.name}
              secondary={t('social.item.assets', { count: w.itemCount })}
              trailing={
                <ActivityAlertToggle
                  kind="watchlist"
                  subjectId={w.watchlistId}
                  enabled={w.activityAlertsEnabled}
                />
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shared With Me (PROJECTPLAN.md §6.9 point 4, §13.2 V2-P9; V3-P6 restructure) —
 * everything the caller's friends currently share, now **grouped by person**:
 * a card per friend who shares, expandable to their portfolios, conglomerates and
 * watchlists (read-only). Each shared item carries an activity-alert toggle whose
 * preference persists now (delivery is Notifications-v2, #368).
 */
export function SharedWithMePage() {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: SHARED_WITH_ME_KEY,
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
    return <Alert tone="error">{t('social.sharedWithMe.error')}</Alert>;
  }

  const people = groupSharedByPerson(data);

  if (people.length === 0) {
    return (
      <EmptyState
        title={t('social.sharedWithMe.emptyTitle')}
        description={t('social.sharedWithMe.emptyBody')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-200">
          {t('social.sharedWithMe.heading')}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500">{t('social.sharedWithMe.subhead')}</p>
      </div>
      <div className="flex flex-col gap-3">
        {people.map((person) => (
          <PersonCard key={person.owner.id} person={person} defaultOpen={people.length === 1} />
        ))}
      </div>
    </div>
  );
}
