import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { Alert } from '@bettertrack/contracts';

import { ALERTS_QUERY_KEY, listAlerts } from '../../lib/alertsApi';
import { EmptyState, Skeleton } from '../../ui';
import { AlertDialog } from '../components/AlertDialog';
import { AlertList } from '../components/AlertList';
import { Alert as AlertBanner, Button } from '../components/ui';

/** TanStack Query polls the list so a fired alert flips to `triggered` without
 * a manual refresh (the socket bell push is V3-P7 — this is the fallback). */
const ALERTS_POLL_INTERVAL_MS = 60_000;

/**
 * `/workboard/alerts` — the price-alerts panel (PROJECTPLAN.md §14, V3-P10 arc
 * b). Lists every alert the caller owns with create / edit / delete / re-arm,
 * all against the #334 CRUD API. The asset-page inline widget shares the same
 * dialog + list components and the same cached query.
 */
export function AlertsPage() {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Alert | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: ({ signal }) => listAlerts(signal),
    refetchInterval: ALERTS_POLL_INTERVAL_MS,
    staleTime: 30_000,
  });

  const alerts = data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Price alerts</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Get notified when an asset crosses a price or moves by a percentage. Evaluated every
            minute against the latest quote.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>+ New alert</Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton height="h-24" />
          <Skeleton height="h-24" />
          <Skeleton height="h-24" />
        </div>
      ) : isError ? (
        <AlertBanner tone="error">Could not load your alerts. Please refresh the page.</AlertBanner>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon="🔔"
          title="No alerts yet"
          description="Create an alert to get notified when an asset hits a price or moves by a percentage."
          cta={
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              New alert →
            </button>
          }
        />
      ) : (
        <AlertList alerts={alerts} showAsset onEdit={setEditing} />
      )}

      {creating ? <AlertDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <AlertDialog existing={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
