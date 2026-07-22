import { useCallback, useState } from 'react';

import type { MonitoringStatusResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { apiBaseUrl } from '../../lib/runtimeConfig';
import { formatDateTime } from '../format';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner } from '../components/ui';

/**
 * Admin Monitoring / Diagnostics page (PROJECTPLAN.md §13.5 V5-P2 arc (a), owner
 * directive 2026-07-19). Surfaces the self-hosted Prometheus + Grafana stack:
 *
 *  - reachable / not-reachable status for Grafana + Prometheus (server-side
 *    probe, fails soft — the page degrades gracefully when the stack is down);
 *  - the external-access posture (deploy opt-in + Grafana password + runtime
 *    kill-switch) with an admin toggle for the runtime switch;
 *  - an embedded Grafana iframe + open-in-new-tab link WHEN external access is
 *    effective; otherwise a note that the dashboards stay localhost/LAN-only.
 *
 * Prometheus is never exposed to the client (no URL rendered) — Grafana is the
 * only embeddable surface, reached through the admin-authenticated proxy.
 */

/** A green/red reachability pill localized through `admin.monitoring.status.*`. */
function ReachBadge({ reachable, detail }: { reachable: boolean; detail: string | null }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={reachable ? 'green' : 'red'}>
        {reachable
          ? t('admin.monitoring.status.reachable')
          : t('admin.monitoring.status.unreachable')}
      </Badge>
      {!reachable && detail ? (
        <span className="font-mono text-xs text-neutral-500">{detail}</span>
      ) : null}
    </span>
  );
}

/** One yes/no condition row for the external-access gate. */
function ConditionRow({ label, met }: { label: string; met: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-800 py-2 last:border-b-0">
      <span className="text-sm text-neutral-300">{label}</span>
      <Badge tone={met ? 'green' : 'neutral'}>
        {met ? t('admin.monitoring.access.yes') : t('admin.monitoring.access.no')}
      </Badge>
    </div>
  );
}

export function MonitoringPage() {
  const t = useT();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<MonitoringStatusResponse | null>(null);

  const resource = useResource((signal) => api.getMonitoringStatus(signal), []);
  const { loading, error, reload } = resource;
  // Prefer the optimistic post-toggle status, falling back to the fetched one.
  const status = override ?? resource.data;

  const toggle = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setActionError(null);
      try {
        setOverride(await api.setMonitoringExternalAccess(enabled));
      } catch {
        setActionError(t('admin.monitoring.actionError'));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <PageHeader
          title={t('admin.monitoring.title')}
          description={t('admin.monitoring.subtitle')}
        />
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            setOverride(null);
            reload();
          }}
        >
          {t('admin.monitoring.refresh')}
        </Button>
      </div>

      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {loading && !status ? <Spinner label={t('admin.monitoring.title')} /> : null}
      {error && !status ? (
        <Alert tone="error">
          {t('admin.monitoring.loadError')}{' '}
          <button className="underline" onClick={reload}>
            {t('admin.monitoring.refresh')}
          </button>
        </Alert>
      ) : null}

      {status ? <MonitoringBody status={status} busy={busy} onToggle={toggle} /> : null}
    </div>
  );
}

function MonitoringBody({
  status,
  busy,
  onToggle,
}: {
  status: MonitoringStatusResponse;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useT();
  const { grafana, prometheus, externalAccess } = status;
  // The runtime toggle only decides anything once the deploy + password gates
  // are met; otherwise external access can't be enabled from the UI at all.
  const canToggle = externalAccess.deployEnabled && externalAccess.passwordSet;
  // Embed the explicit subdomain URL when configured, else the admin-proxy path
  // under this SPA's own API origin.
  const embedUrl = externalAccess.effective
    ? (status.externalUrl ?? `${apiBaseUrl()}/admin/monitoring/grafana/`)
    : null;

  return (
    <div className="flex flex-col gap-6">
      {/* Stack reachability */}
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <span className="text-sm font-medium text-neutral-300">
          {t('admin.monitoring.status.title')}
        </span>
        <div className="flex items-center justify-between gap-3 border-b border-neutral-800 py-2">
          <span className="text-sm text-neutral-200">{t('admin.monitoring.status.grafana')}</span>
          <ReachBadge reachable={grafana.reachable} detail={grafana.detail} />
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <span className="text-sm text-neutral-200">
            {t('admin.monitoring.status.prometheus')}
          </span>
          <ReachBadge reachable={prometheus.reachable} detail={prometheus.detail} />
        </div>
        <p className="text-xs text-neutral-500">{t('admin.monitoring.prometheusNote')}</p>
      </div>

      {/* External access posture + runtime kill-switch */}
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-neutral-300">
            {t('admin.monitoring.access.title')}
          </span>
          <Badge tone={externalAccess.effective ? 'sky' : 'neutral'}>
            {externalAccess.effective
              ? t('admin.monitoring.access.effectiveOn')
              : t('admin.monitoring.access.effectiveOff')}
          </Badge>
        </div>
        <p className="text-xs text-neutral-500">{t('admin.monitoring.access.description')}</p>

        <div className="flex flex-col">
          <ConditionRow
            label={t('admin.monitoring.access.deployEnabled')}
            met={externalAccess.deployEnabled}
          />
          <ConditionRow
            label={t('admin.monitoring.access.passwordSet')}
            met={externalAccess.passwordSet}
          />
          <ConditionRow
            label={t('admin.monitoring.access.killSwitchOn')}
            met={externalAccess.killSwitchOn}
          />
        </div>

        {canToggle ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <span className="text-xs text-neutral-500">
              {externalAccess.updatedAt
                ? `${t('admin.monitoring.access.lastChanged')}: ${formatDateTime(externalAccess.updatedAt)}`
                : t('admin.monitoring.access.never')}
            </span>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onToggle(!externalAccess.killSwitchOn)}
            >
              {externalAccess.killSwitchOn
                ? t('admin.monitoring.access.disable')
                : t('admin.monitoring.access.enable')}
            </Button>
          </div>
        ) : (
          <Alert tone="info">{t('admin.monitoring.access.needsDeploy')}</Alert>
        )}
      </div>

      {/* Embedded Grafana — only when external access is effective */}
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-neutral-300">
            {t('admin.monitoring.status.grafana')}
          </span>
          {embedUrl ? (
            <a
              href={embedUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-sky-400 underline hover:text-sky-300"
            >
              {t('admin.monitoring.embed.open')}
            </a>
          ) : null}
        </div>
        {embedUrl ? (
          <iframe
            src={embedUrl}
            title={t('admin.monitoring.embed.frameTitle')}
            className="h-[60vh] w-full rounded-md border border-neutral-800 bg-neutral-950 sm:h-[70vh]"
          />
        ) : (
          <Alert tone="info">{t('admin.monitoring.embed.hidden')}</Alert>
        )}
      </div>
    </div>
  );
}
