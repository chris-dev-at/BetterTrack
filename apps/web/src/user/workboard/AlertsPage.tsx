import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { Alert, UpdateAlertSharingRequest } from '@bettertrack/contracts';

import {
  ALERT_SHARING_QUERY_KEY,
  ALERTS_QUERY_KEY,
  getAlertSharing,
  listAlerts,
  updateAlertSharing,
} from '../../lib/alertsApi';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { AlertDialog } from '../components/AlertDialog';
import { AlertList } from '../components/AlertList';
import { Dialog } from '../components/Dialog';
import { Alert as AlertBanner, Button } from '../components/ui';

/** TanStack Query polls the list so a fired alert flips to `triggered` without
 * a manual refresh (the socket bell push is V3-P7 — this is the fallback). */
const ALERTS_POLL_INTERVAL_MS = 60_000;

/**
 * The owner's alert-visibility control (#455): a switch exposing every current
 * and future alert to the caller's FOLLOWERS. Alerts reveal watched assets +
 * price targets and anyone may follow, so enabling walks the §16 friction
 * ladder — a strong warning dialog whose confirm sends the explicit
 * acknowledgment the server requires. Disabling is immediate and stops
 * follower delivery at once.
 */
function AlertSharingControl() {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data } = useQuery({
    queryKey: ALERT_SHARING_QUERY_KEY,
    queryFn: ({ signal }) => getAlertSharing(signal),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (body: UpdateAlertSharingRequest) => updateAlertSharing(body),
    onSuccess: (result) => {
      queryClient.setQueryData(ALERT_SHARING_QUERY_KEY, result);
      setConfirming(false);
    },
  });

  if (!data) return null;
  const on = data.visibleToFollowers;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-100">
            {t('workboard.alerts.sharing.title')}
          </p>
          <p className="text-xs text-neutral-500">
            {t(on ? 'workboard.alerts.sharing.onHint' : 'workboard.alerts.sharing.offHint')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t('workboard.alerts.sharing.toggleAria')}
          disabled={mutation.isPending}
          onClick={() =>
            on ? mutation.mutate({ visibleToFollowers: false }) : setConfirming(true)
          }
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60 ${
            on ? 'bg-sky-600' : 'bg-neutral-700'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              on ? 'translate-x-[18px]' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      {mutation.isError ? (
        <AlertBanner tone="error">{t('workboard.alerts.sharing.error')}</AlertBanner>
      ) : null}
      {confirming ? (
        <Dialog
          title={t('workboard.alerts.sharing.confirmTitle')}
          onClose={() => setConfirming(false)}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-amber-400">{t('workboard.alerts.sharing.confirmWarning')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {t('workboard.alerts.sharing.confirmCancel')}
              </Button>
              <Button
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ visibleToFollowers: true, acknowledgeFollowers: true })
                }
              >
                {t('workboard.alerts.sharing.confirmEnable')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * `/workboard/alerts` — the price-alerts panel (PROJECTPLAN.md §14, V3-P10 arc
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {t('workboard.alerts.title')}
          </h1>
          <p className="mt-1 text-sm text-neutral-400">{t('workboard.alerts.subtitle')}</p>
        </div>
        <Button onClick={() => setCreating(true)}>{t('workboard.alerts.newAlert')}</Button>
      </div>

      <AlertSharingControl />

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
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
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
