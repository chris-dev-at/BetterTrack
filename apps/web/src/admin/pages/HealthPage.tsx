import type { ReactNode } from 'react';

import type {
  AdminBackupStatusLevel,
  AdminHealthComponent,
  AdminHealthResponse,
  HealthStatus,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatBackupAge, formatDuration } from '../formatDuration';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner } from '../components/ui';

const STATUS_TONE: Record<HealthStatus, 'green' | 'amber' | 'red'> = {
  ok: 'green',
  degraded: 'amber',
  down: 'red',
};

/** A status pill localized through `admin.health.status.*`. */
function StatusBadge({ status }: { status: HealthStatus }) {
  const t = useT();
  return <Badge tone={STATUS_TONE[status]}>{t(`admin.health.status.${status}`)}</Badge>;
}

/** One labelled component row: name, its status pill, and optional detail slot. */
function ComponentRow({
  label,
  status,
  children,
}: {
  label: string;
  status: HealthStatus;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-neutral-800 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-neutral-200">{label}</span>
        <StatusBadge status={status} />
      </div>
      {children ? <div className="text-xs text-neutral-400 sm:text-right">{children}</div> : null}
    </div>
  );
}

function pingDetail(component: AdminHealthComponent): string | null {
  const parts: string[] = [];
  if (component.latencyMs !== undefined) parts.push(`${Math.round(component.latencyMs)} ms`);
  if (component.detail) parts.push(component.detail);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Admin health page (PROJECTPLAN.md §13.4 V4-P5a): the operator diagnostics
 * surface for `GET /admin/health`. Renders every component's status (DB, Redis,
 * market-data providers, the job system, the realtime gateway) plus app version
 * and uptime, with loading and error states, and a manual refresh. The public
 * `/health` liveness probe stays separate; this is admin-only and richer.
 */
export function HealthPage() {
  const t = useT();
  const health = useResource((signal) => api.getAdminHealth(signal), []);
  const { data, loading, error, reload } = health;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader title={t('admin.health.title')} description={t('admin.health.subtitle')} />
        <Button variant="secondary" onClick={reload} disabled={loading}>
          {t('admin.health.refresh')}
        </Button>
      </div>

      {loading && data ? (
        <span className="sr-only" role="status" aria-label={t('common.loading')}>
          {t('common.loading')}
        </span>
      ) : null}

      <section aria-busy={loading} aria-label={t('admin.health.title')}>
        {loading && !data ? <Spinner label={t('common.loading')} /> : null}
        {error ? <Alert tone="error">{t('admin.health.loadError')}</Alert> : null}

        {data ? <HealthBody data={data} /> : null}
      </section>

      {/* The Overview's backup attention row points here, so the evidence behind
          it has to live here too (#1406 W1). Read-only and fail-soft: the panel
          is a projection of the scheduler's own status file, and this page never
          starts a dump, a drill, or an upload. */}
      <BackupReadinessPanel />
    </div>
  );
}

const BACKUP_LEVEL_TONE: Record<AdminBackupStatusLevel, 'green' | 'amber' | 'red' | 'neutral'> = {
  ok: 'green',
  warn: 'amber',
  critical: 'red',
  unknown: 'neutral',
};

/**
 * Backup / restore-drill readiness (docs/ops.md: 26 h dump, 35 d drill). Green
 * means a recent dump AND a recent drill; amber means the recovery point exists
 * but is unproven; red means there is no trustworthy recovery point.
 */
function BackupReadinessPanel() {
  const t = useT();
  const backup = useResource((signal) => api.getBackupStatus(signal), []);
  const { data, loading, error, reload } = backup;

  return (
    <section
      aria-label={t('admin.backup.title')}
      className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-300">{t('admin.backup.title')}</h2>
        {data ? (
          <Badge tone={BACKUP_LEVEL_TONE[data.level]}>
            {t(`admin.backup.level.${data.level}`)}
          </Badge>
        ) : null}
      </div>

      {loading && !data ? <Spinner label={t('common.loading')} /> : null}
      {error ? (
        <Alert tone="info">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('admin.backup.loadError')}</span>
            <Button variant="secondary" onClick={reload}>
              {t('common.retry')}
            </Button>
          </div>
        </Alert>
      ) : null}

      {data ? (
        <>
          <p className="text-xs text-neutral-400">{t(`admin.backup.reason.${data.reason}`)}</p>
          {data.configured ? (
            <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <BackupFact
                label={t('admin.backup.lastDump')}
                value={formatBackupAge(t, data.backup.ageSeconds)}
              />
              <BackupFact
                label={t('admin.backup.lastDrill')}
                value={formatBackupAge(t, data.restore.ageSeconds)}
              />
              <BackupFact
                label={t('admin.backup.dumpBudget')}
                value={formatDuration(t, data.backup.maxAgeSeconds)}
              />
              <BackupFact
                label={t('admin.backup.drillBudget')}
                value={formatDuration(t, data.restore.maxAgeSeconds)}
              />
            </dl>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function BackupFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="text-neutral-200">{value}</dd>
    </div>
  );
}

function HealthBody({ data }: { data: AdminHealthResponse }) {
  const t = useT();
  const { components } = data;

  return (
    <div className="flex flex-col gap-6">
      {/* Overall verdict + build/uptime meta */}
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-neutral-300">{t('admin.health.overall')}</span>
          <StatusBadge status={data.status} />
        </div>
        <dl className="grid grid-cols-2 gap-3 text-xs text-neutral-400 sm:grid-cols-3">
          <div className="flex flex-col">
            <dt className="uppercase tracking-wide text-neutral-400">
              {t('admin.health.version')}
            </dt>
            <dd className="font-mono text-neutral-200">{data.version}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="uppercase tracking-wide text-neutral-400">{t('admin.health.uptime')}</dt>
            <dd className="text-neutral-200">{formatDuration(t, data.uptimeSeconds)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="uppercase tracking-wide text-neutral-400">
              {t('admin.health.checkedAt')}
            </dt>
            <dd className="text-neutral-200">{new Date(data.checkedAt).toLocaleTimeString()}</dd>
          </div>
        </dl>
      </div>

      {/* Per-component status list */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4">
        <ComponentRow
          label={t('admin.health.components.database')}
          status={components.database.status}
        >
          {pingDetail(components.database)}
        </ComponentRow>
        <ComponentRow label={t('admin.health.components.redis')} status={components.redis.status}>
          {pingDetail(components.redis)}
        </ComponentRow>

        <ComponentRow
          label={t('admin.health.components.providers')}
          status={components.providers.status}
        >
          {components.providers.breakers.length === 0
            ? t('admin.health.providers.none')
            : components.providers.breakers.map((b) => (
                <span key={b.providerId} className="ml-2 inline-block">
                  {b.providerId}: {t(`admin.health.circuit.${b.state}`)}
                </span>
              ))}
        </ComponentRow>

        <ComponentRow label={t('admin.health.components.queues')} status={components.queues.status}>
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <span>
              {components.queues.heartbeat.ageSeconds === null
                ? t('admin.health.queues.heartbeatUnknown')
                : t('admin.health.queues.heartbeatAge', {
                    seconds: components.queues.heartbeat.ageSeconds,
                  })}
            </span>
            {!components.queues.available ? (
              <span>{t('admin.health.queues.unavailable')}</span>
            ) : components.queues.depths.length === 0 ? (
              <span>{t('admin.health.queues.empty')}</span>
            ) : (
              <span>
                {t('admin.health.queues.summary', {
                  queues: components.queues.depths.length,
                  waiting: components.queues.depths.reduce((sum, q) => sum + q.waiting, 0),
                  failed: components.queues.depths.reduce((sum, q) => sum + q.failed, 0),
                })}
              </span>
            )}
          </div>
        </ComponentRow>

        <ComponentRow
          label={t('admin.health.components.gateway')}
          status={components.gateway.status}
        >
          {components.gateway.enabled
            ? t('admin.health.gateway.connections', {
                count: components.gateway.connections,
              })
            : t('admin.health.gateway.disabled')}
        </ComponentRow>
      </div>

      <FailoverPanel providers={components.providers} />
    </div>
  );
}

/**
 * Provider failover attribution (§13.5 V5-P1c): which source is serving each
 * chain, per-provider serve counts and the recent switch events. A niche panel
 * that stays folded away — it renders nothing until a secondary is configured and
 * has served traffic, so a single-provider deploy sees no extra chrome.
 */
function FailoverPanel({
  providers,
}: {
  providers: AdminHealthResponse['components']['providers'];
}) {
  const t = useT();
  const { chains, switches, attribution } = providers;
  if (chains.length === 0 && switches.length === 0 && attribution.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <span className="text-sm font-medium text-neutral-300">
        {t('admin.health.failover.title')}
      </span>

      {chains.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-neutral-400">
          {chains.map((c) => {
            const failedOver = c.serving !== null && c.serving !== c.primaryId;
            return (
              <li key={c.primaryId} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-neutral-200">{c.providerIds.join(' → ')}</span>
                {c.serving ? (
                  <Badge tone={failedOver ? 'amber' : 'green'}>{c.serving}</Badge>
                ) : null}
                {failedOver ? <span>{t('admin.health.failover.viaFailover')}</span> : null}
                {c.since ? (
                  <span>
                    {t('admin.health.failover.since', {
                      time: new Date(c.since).toLocaleTimeString(),
                    })}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {attribution.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-400">
          {attribution.map((a) => (
            <span key={a.providerId}>
              <span className="text-neutral-200">{a.providerId}</span>:{' '}
              <span>{t('admin.health.failover.served', { count: a.serves })}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1 text-xs text-neutral-400">
        <span className="uppercase tracking-wide text-neutral-400">
          {t('admin.health.failover.switchesTitle')}
        </span>
        {switches.length === 0 ? (
          <span>{t('admin.health.failover.noSwitches')}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {switches.slice(0, 5).map((s, i) => (
              <li key={`${s.at}-${i}`} className="font-mono text-neutral-300">
                {s.from ?? '—'} → {s.to} · {new Date(s.at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
