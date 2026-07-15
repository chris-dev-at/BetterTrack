import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { Alert } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ALERTS_QUERY_KEY, deleteAlert, rearmAlert } from '../../lib/alertsApi';
import { formatDateTime } from '../../lib/format';
import { ALERT_STATUS_META, describeAlertRule } from './alertMeta';
import { Alert as AlertBanner, cx } from './ui';

function StatusBadge({ alert }: { alert: Alert }) {
  const t = useT();
  const meta = ALERT_STATUS_META[alert.status];
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        meta.className,
      )}
    >
      {t(meta.labelKey)}
    </span>
  );
}

function AlertRow({
  alert,
  showAsset,
  onEdit,
}: {
  alert: Alert;
  showAsset: boolean;
  onEdit: (alert: Alert) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();

  const rearmMutation = useMutation({
    mutationFn: () => rearmAlert(alert.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY }),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAlert(alert.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY }),
  });

  const busy = rearmMutation.isPending || deleteMutation.isPending;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {showAsset ? (
            <Link
              to={`/assets/${alert.asset.id}`}
              className="font-mono text-sm text-sky-400 hover:underline"
            >
              {alert.asset.symbol}
            </Link>
          ) : null}
          <p className="text-sm font-medium text-neutral-100">
            {describeAlertRule(t, alert, alert.asset.currency)}
          </p>
        </div>
        <StatusBadge alert={alert} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span>
          {alert.repeat ? t('workboard.alerts.list.repeat') : t('workboard.alerts.list.oneShot')}
        </span>
        {alert.lastTriggeredAt ? (
          <span>
            {t('workboard.alerts.list.lastFired', { time: formatDateTime(alert.lastTriggeredAt) })}
          </span>
        ) : (
          <span>{t('workboard.alerts.list.neverFired')}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
        {alert.status === 'triggered' ? (
          <button
            type="button"
            onClick={() => rearmMutation.mutate()}
            disabled={busy}
            className="font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-neutral-600"
          >
            {rearmMutation.isPending
              ? t('workboard.alerts.list.rearming')
              : t('workboard.alerts.list.rearm')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onEdit(alert)}
          disabled={busy}
          className="font-medium text-neutral-300 hover:text-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-600"
        >
          {t('common.edit')}
        </button>
        <button
          type="button"
          onClick={() => deleteMutation.mutate()}
          disabled={busy}
          className="font-medium text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:text-neutral-600"
        >
          {deleteMutation.isPending ? t('workboard.alerts.list.deleting') : t('common.delete')}
        </button>
      </div>

      {rearmMutation.isError || deleteMutation.isError ? (
        <AlertBanner tone="error">{t('workboard.alerts.list.updateError')}</AlertBanner>
      ) : null}
    </li>
  );
}

/**
 * Renders a list of price alerts with per-row edit / delete / re-arm actions
 * (PROJECTPLAN.md §14). Shared by the Workboard panel (which shows the asset
 * link per row) and the asset-page inline widget (`showAsset={false}` — the
 * page already names the asset). Editing is delegated to the parent via
 * `onEdit`, which opens the shared {@link AlertDialog}.
 */
export function AlertList({
  alerts,
  showAsset,
  onEdit,
}: {
  alerts: Alert[];
  showAsset: boolean;
  onEdit: (alert: Alert) => void;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {alerts.map((alert) => (
        <AlertRow key={alert.id} alert={alert} showAsset={showAsset} onEdit={onEdit} />
      ))}
    </ul>
  );
}
