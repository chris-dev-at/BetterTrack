import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { Alert, AlertStatus } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ALERTS_QUERY_KEY, deleteAlert, rearmAlert } from '../../lib/alertsApi';
import { formatDateTime } from '../../lib/format';
import { Badge, Button, type BadgeTone } from '../../ui/origin';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { ALERT_STATUS_META, describeAlertRule } from './alertMeta';

/** §14 status → Badge tone: active reads positive, triggered draws the eye
 * (gold), disabled/paused stays neutral. */
const STATUS_TONE: Record<AlertStatus, BadgeTone> = {
  active: 'pos',
  triggered: 'gold',
  disabled: 'neutral',
};

function StatusBadge({ alert }: { alert: Alert }) {
  const t = useT();
  const meta = ALERT_STATUS_META[alert.status];
  return <Badge tone={STATUS_TONE[alert.status]}>{t(meta.labelKey)}</Badge>;
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
  const feedback = useMutationFeedback();
  /**
   * Delete used to fire on the first click, from a `size="sm"` danger button
   * sitting directly beside Edit — one slip permanently removed a rule the user
   * had built, with no undo and no confirmation. The two-step inline confirm is
   * the idiom already used for cash sources, standing orders and transactions,
   * so it costs no new component and reads the same way everywhere.
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const rearmMutation = useMutation({
    mutationFn: () => rearmAlert(alert.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY });
      feedback.success(t('mutationFeedback.alertRearmed'));
    },
    onError: () => feedback.error(t('workboard.alerts.list.updateError')),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAlert(alert.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY });
      feedback.success(t('mutationFeedback.alertDeleted'));
    },
    onError: () => feedback.error(t('workboard.alerts.list.updateError')),
  });

  const busy = rearmMutation.isPending || deleteMutation.isPending;

  return (
    <li className="bt-band__row flex flex-col gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {showAsset ? (
            <Link className="bt-link" style={{ fontSize: 12.5 }} to={`/assets/${alert.asset.id}`}>
              {alert.asset.symbol}
            </Link>
          ) : null}
          <p className="bt-row-title">{describeAlertRule(t, alert, alert.asset.currency)}</p>
        </div>
        <StatusBadge alert={alert} />
      </div>

      <div className="bt-meta flex flex-wrap items-center gap-x-3 gap-y-1">
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

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {alert.status === 'triggered' ? (
          <Button disabled={busy} onClick={() => rearmMutation.mutate()} size="sm" variant="quiet">
            {rearmMutation.isPending
              ? t('workboard.alerts.list.rearming')
              : t('workboard.alerts.list.rearm')}
          </Button>
        ) : null}
        <Button disabled={busy} onClick={() => onEdit(alert)} size="sm" variant="quiet">
          {t('common.edit')}
        </Button>
        {confirmingDelete ? (
          <>
            <span className="bt-muted self-center text-xs">
              {t('workboard.alerts.list.deleteConfirm')}
            </span>
            <Button
              disabled={busy}
              onClick={() => deleteMutation.mutate()}
              size="sm"
              variant="danger"
            >
              {deleteMutation.isPending ? t('workboard.alerts.list.deleting') : t('common.delete')}
            </Button>
            <Button disabled={busy} onClick={() => setConfirmingDelete(false)} size="sm">
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            size="sm"
            variant="danger"
          >
            {t('common.delete')}
          </Button>
        )}
      </div>
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
    <ul className="bt-panel bt-band">
      {alerts.map((alert) => (
        <AlertRow key={alert.id} alert={alert} showAsset={showAsset} onEdit={onEdit} />
      ))}
    </ul>
  );
}
