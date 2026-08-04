import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { Alert } from '@bettertrack/contracts';

import { ALERTS_QUERY_KEY, listAlerts } from '../../lib/alertsApi';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { Button, PageHead } from '../../ui/origin';
import { AlertDialog } from '../components/AlertDialog';
import { AlertList } from '../components/AlertList';
import { Alert as AlertBanner } from '../components/ui';

/** TanStack Query polls the list so a fired alert flips to `triggered` without
 * a manual refresh (the socket bell push is V3-P7 — this is the fallback). */
const ALERTS_POLL_INTERVAL_MS = 60_000;

/**
 * `/workbench/alerts` — the price-alerts panel (PROJECTPLAN.md §14, V3-P10 arc
 * b). Lists every alert the caller owns with create / edit / delete / re-arm,
 * all against the #334 CRUD API. The asset-page inline widget shares the same
 * dialog + list components and the same cached query.
 */
export function AlertsPage() {
  const t = useT();
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
    <div className="bt-phone-surface bt-alerts-page flex flex-col gap-6">
      <PageHead
        actions={
          <Button onClick={() => setCreating(true)} variant="primary">
            {t('workboard.alerts.newAlert')}
          </Button>
        }
        sub={t('workboard.alerts.subtitle')}
        title={t('workboard.alerts.title')}
      />

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton height="h-24" />
          <Skeleton height="h-24" />
          <Skeleton height="h-24" />
        </div>
      ) : isError ? (
        <AlertBanner tone="error">{t('workboard.alerts.loadError')}</AlertBanner>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon="🔔"
          title={t('workboard.alerts.emptyTitle')}
          description={t('workboard.alerts.emptyDescription')}
          cta={
            <button className="bt-link" onClick={() => setCreating(true)} type="button">
              {t('workboard.alerts.emptyCta')}
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
