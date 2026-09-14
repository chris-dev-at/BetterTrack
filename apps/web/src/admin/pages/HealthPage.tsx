import { useCallback } from 'react';
import type { ReactNode } from 'react';

import type {
  AdminBackupStatusLevel,
  AdminHealthComponent,
  AdminHealthResponse,
  AdminOpsJobsResponse,
  AdminOpsQueue,
  AdminOpsSchedule,
  HealthStatus,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatBackupAge, formatDuration } from '../formatDuration';
import { useLiveRefresh } from '../useLiveRefresh';
import { useResource } from '../useResource';
import { LiveRefreshControl } from '../components/LiveRefreshControl';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import {
  EDGE_BOTTOM,
  SURFACE_HEADER,
  TEXT_MICRO,
  TEXT_MONO,
  TEXT_MUTED,
  TEXT_NUM,
} from '../components/tokens';
import type { Tone } from '../components/tokens';
import {
  Alert,
  AsyncReadState,
  Badge,
  Button,
  DataTable,
  EmptyState,
  KeyValueList,
  PageHeader,
  Panel,
  PanelHeader,
  Spinner,
  StatTile,
  Td,
  Th,
  cx,
} from '../components/ui';

/**
 * Operations → Health & queues (#1406 W4): the cockpit landing.
 *
 * W1 shipped this as a component-status list. W4 makes it the workspace's
 * landing and adds the three signals an operator actually opens the console
 * for at 3 a.m.: what is piling up in the queues, whether the scheduled work
 * ran (and what the sweeps deleted), and what has failed permanently.
 *
 * Every number here is a READING. There is no retry, no discard, no
 * enqueue — the #1406 DECISION rejected a generic queue button because per-job
 * idempotency and privacy differ too much for one control to be safe, and the
 * page says so where the failures are listed rather than leaving the absence
 * looking like an oversight.
 */

const STATUS_TONE: Record<HealthStatus, Tone> = {
  ok: 'green',
  degraded: 'amber',
  down: 'red',
};

const BACKUP_LEVEL_TONE: Record<AdminBackupStatusLevel, Tone> = {
  ok: 'green',
  warn: 'amber',
  critical: 'red',
  unknown: 'neutral',
};

/** A status pill localized through `admin.health.status.*`. */
function StatusBadge({ status }: { status: HealthStatus }) {
  const t = useT();
  return <Badge tone={STATUS_TONE[status]}>{t(`admin.health.status.${status}`)}</Badge>;
}

function pingDetail(component: AdminHealthComponent): string | null {
  const parts: string[] = [];
  if (component.latencyMs !== undefined) parts.push(`${Math.round(component.latencyMs)} ms`);
  if (component.detail) parts.push(component.detail);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Absolute clock time, or an em dash — never an invented value. */
function at(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

/**
 * How far in the future/past a timestamp is, phrased for a schedule column.
 * A scheduled run whose `next` has already passed is OVERDUE, and that is the
 * single most useful thing this table can say.
 */
function relativeRun(t: TranslateFn, iso: string | null, now: number): ReactNode {
  if (iso === null) return <span className={TEXT_MUTED}>—</span>;
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return <span className={TEXT_MUTED}>—</span>;
  const deltaSeconds = Math.round((target - now) / 1000);
  if (deltaSeconds < 0) {
    return (
      <span className="text-amber-400">
        {t('admin.ops.schedules.overdue', { age: formatDuration(t, -deltaSeconds) })}
      </span>
    );
  }
  return <span>{t('admin.ops.schedules.in', { age: formatDuration(t, deltaSeconds) })}</span>;
}

export function HealthPage() {
  const t = useT();

  const health = useResource((signal) => api.getAdminHealth(signal), []);
  const jobs = useResource((signal) => api.getOpsJobs(signal), []);
  const backup = useResource((signal) => api.getBackupStatus(signal), []);
  const version = useResource((signal) => api.getVersion(signal), []);

  // One fan-out so the whole cockpit is read as of one moment; four panels
  // refreshing on four timers would show four different instants side by side.
  const reloadAll = useCallback(() => {
    health.reload();
    jobs.reload();
    backup.reload();
    version.reload();
  }, [health, jobs, backup, version]);

  const live = useLiveRefresh(reloadAll);
  const busy = health.loading || jobs.loading || backup.loading || version.loading;

  // Tab counts are decorative: while a read is loading or failed, pass nothing
  // rather than a confident zero (the W2 rule). Only a non-zero dead-letter
  // count is worth a chip — a "0" badge is chrome, not information.
  const failureTotal = jobs.loading || jobs.error !== null ? undefined : jobs.data?.failureTotal;
  const counts = failureTotal ? { '/admin/health': failureTotal } : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        actions={<LiveRefreshControl busy={busy} live={live} />}
        description={t('admin.ops.health.subtitle')}
        eyebrow={t('admin.nav.sections.operations')}
        title={t('admin.ops.health.title')}
      />
      <WorkspaceTabs {...(counts ? { counts } : {})} />

      <section aria-busy={health.loading} aria-label={t('admin.ops.system.title')}>
        {health.loading || health.error ? (
          <AsyncReadState
            error={health.error}
            loading={health.loading && health.data === null}
            onRetry={health.reload}
            retryable={health.retryable}
          />
        ) : null}
        {health.data ? (
          <SystemPanel
            data={health.data}
            shortCommit={version.data?.shortCommit ?? null}
            // Held back until the deploy marker has answered: falling straight
            // through to the API version would flash a value that is not the
            // commit and then swap it, which is exactly the wrong answer to
            // "is my merge live?". And when the marker cannot be read at all,
            // the tile says the commit is unavailable instead of showing the
            // API version as though it were one.
            versionError={version.error !== null}
            versionLoading={version.loading}
          />
        ) : null}
      </section>

      <section aria-busy={jobs.loading} aria-label={t('admin.ops.queues.title')}>
        {jobs.loading || jobs.error ? (
          <AsyncReadState
            error={jobs.error}
            loading={jobs.loading && jobs.data === null}
            onRetry={jobs.reload}
            retryable={jobs.retryable}
          />
        ) : null}
        {jobs.data ? <JobsBody data={jobs.data} /> : null}
      </section>

      {/* The Overview's backup attention row points here, so the evidence behind
          it has to live here too (#1406 W1). Read-only and fail-soft: the panel
          is a projection of the scheduler's own status file, and this page never
          starts a dump, a drill, or an upload. */}
      <section aria-busy={backup.loading} aria-label={t('admin.backup.title')}>
        <Panel padded={false}>
          <PanelHeader
            actions={
              backup.data ? (
                <Badge tone={BACKUP_LEVEL_TONE[backup.data.level]}>
                  {t(`admin.backup.level.${backup.data.level}`)}
                </Badge>
              ) : undefined
            }
            title={t('admin.backup.title')}
          />
          <div className="p-4">
            {backup.loading && backup.data === null ? <Spinner /> : null}
            {/* Keeps W1's specific wording rather than the generic read banner: an
              unreadable backup status is the one failure on this page an
              operator must be able to name without opening the network tab. */}
            {backup.error ? (
              <Alert tone="info">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t('admin.backup.loadError')}</span>
                  <Button onClick={backup.reload} size="sm" variant="secondary">
                    {t('common.retry')}
                  </Button>
                </div>
              </Alert>
            ) : null}
            {backup.data ? (
              <>
                <p className={cx(TEXT_MUTED, 'mb-2')}>
                  {t(`admin.backup.reason.${backup.data.reason}`)}
                </p>
                {backup.data.configured ? (
                  <KeyValueList
                    rows={[
                      {
                        label: t('admin.backup.lastDump'),
                        value: formatBackupAge(t, backup.data.backup.ageSeconds),
                      },
                      {
                        label: t('admin.backup.lastDrill'),
                        value: formatBackupAge(t, backup.data.restore.ageSeconds),
                      },
                      {
                        label: t('admin.backup.dumpBudget'),
                        value: formatDuration(t, backup.data.backup.maxAgeSeconds),
                      },
                      {
                        label: t('admin.backup.drillBudget'),
                        value: formatDuration(t, backup.data.restore.maxAgeSeconds),
                      },
                    ]}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </Panel>
      </section>
    </div>
  );
}

/** Build identity, uptime and every dependency's live status. */
function SystemPanel({
  data,
  shortCommit,
  versionError,
  versionLoading,
}: {
  data: AdminHealthResponse;
  shortCommit: string | null;
  versionError: boolean;
  versionLoading: boolean;
}) {
  const t = useT();
  const { components } = data;

  const componentRows: Array<{ label: string; status: HealthStatus; detail: ReactNode }> = [
    {
      label: t('admin.health.components.database'),
      status: components.database.status,
      detail: pingDetail(components.database),
    },
    {
      label: t('admin.health.components.redis'),
      status: components.redis.status,
      detail: pingDetail(components.redis),
    },
    {
      label: t('admin.health.components.providers'),
      status: components.providers.status,
      detail:
        components.providers.breakers.length === 0
          ? t('admin.health.providers.none')
          : components.providers.breakers
              .map((b) => `${b.providerId}: ${t(`admin.health.circuit.${b.state}`)}`)
              .join(' · '),
    },
    {
      label: t('admin.health.components.queues'),
      status: components.queues.status,
      detail:
        components.queues.heartbeat.ageSeconds === null
          ? t('admin.health.queues.heartbeatUnknown')
          : t('admin.health.queues.heartbeatAge', {
              seconds: components.queues.heartbeat.ageSeconds,
            }),
    },
    {
      label: t('admin.health.components.gateway'),
      status: components.gateway.status,
      detail: components.gateway.enabled
        ? t('admin.health.gateway.connections', { count: components.gateway.connections })
        : t('admin.health.gateway.disabled'),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t('admin.health.overall')}
          tone={STATUS_TONE[data.status]}
          value={t(`admin.health.status.${data.status}`)}
        />
        <StatTile label={t('admin.health.uptime')} value={formatDuration(t, data.uptimeSeconds)} />
        <StatTile
          detail={
            versionError
              ? t('admin.ops.system.versionUnavailable')
              : t('admin.ops.system.versionDetail')
          }
          label={t('admin.ops.system.build')}
          tone={versionError ? 'amber' : 'neutral'}
          // The deployed commit is the answer to "is my merge live?"; the API
          // version alone cannot answer it, because it never changes.
          value={
            <span className={TEXT_MONO}>
              {versionLoading ? '…' : versionError ? '—' : (shortCommit ?? data.version)}
            </span>
          }
        />
        <StatTile
          label={t('admin.health.checkedAt')}
          value={new Date(data.checkedAt).toLocaleTimeString()}
        />
      </div>

      <Panel padded={false}>
        <PanelHeader title={t('admin.ops.system.components')} />
        <ul className="divide-y divide-neutral-800">
          {componentRows.map((row) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              key={row.label}
            >
              <span className="flex items-center gap-3">
                <span className="text-[13px] font-medium text-neutral-100">{row.label}</span>
                <StatusBadge status={row.status} />
              </span>
              {row.detail ? (
                <span className={cx(TEXT_MUTED, TEXT_NUM, 'text-right')}>{row.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/** Queue depths, schedules and permanent failures. */
function JobsBody({ data }: { data: AdminOpsJobsResponse }) {
  const t = useT();
  const now = Date.parse(data.checkedAt);

  if (!data.available) {
    return (
      <Alert tone="info">
        {/* "No jobs waiting" and "I cannot see the jobs" are different facts. */}
        {t('admin.ops.queues.unavailable')}
      </Alert>
    );
  }

  // An operator scanning for trouble wants the busy and broken queues first;
  // the two dozen idle ones are noise until they are not.
  const busyFirst = [...data.queues].sort(
    (a, b) => weightOf(b) - weightOf(a) || a.name.localeCompare(b.name),
  );
  const active = busyFirst.filter((queue) => weightOf(queue) > 0);
  const idleCount = data.queues.length - active.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t('admin.ops.queues.waiting')}
          tone={sum(data.queues, 'waiting') > 25 ? 'amber' : 'neutral'}
          value={sum(data.queues, 'waiting')}
        />
        <StatTile label={t('admin.ops.queues.active')} value={sum(data.queues, 'active')} />
        <StatTile
          label={t('admin.ops.queues.failed')}
          tone={sum(data.queues, 'failed') > 0 ? 'red' : 'neutral'}
          value={sum(data.queues, 'failed')}
        />
        <StatTile
          detail={
            data.heartbeatAgeSeconds === null
              ? t('admin.health.queues.heartbeatUnknown')
              : t('admin.ops.queues.heartbeatBudget', { seconds: data.heartbeatIntervalSeconds })
          }
          label={t('admin.ops.queues.heartbeat')}
          tone={heartbeatTone(data)}
          value={
            data.heartbeatAgeSeconds === null
              ? '—'
              : t('admin.health.queues.heartbeatAge', { seconds: data.heartbeatAgeSeconds })
          }
        />
      </div>

      <Panel padded={false}>
        <PanelHeader
          description={
            idleCount > 0 ? t('admin.ops.queues.idleHidden', { count: idleCount }) : undefined
          }
          title={t('admin.ops.queues.title')}
        />
        {active.length === 0 ? (
          <div className="p-4">
            <EmptyState>{t('admin.ops.queues.allIdle')}</EmptyState>
          </div>
        ) : (
          <DataTable minWidth="40rem">
            <thead className={cx(SURFACE_HEADER, EDGE_BOTTOM)}>
              <tr>
                <Th>{t('admin.ops.queues.queue')}</Th>
                <Th className="text-right">{t('admin.ops.queues.waiting')}</Th>
                <Th className="text-right">{t('admin.ops.queues.active')}</Th>
                <Th className="text-right">{t('admin.ops.queues.delayed')}</Th>
                <Th className="text-right">{t('admin.ops.queues.failed')}</Th>
                <Th className="text-right">{t('admin.ops.queues.paused')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {active.map((queue) => (
                <tr key={queue.name}>
                  <Td className="font-medium text-neutral-100">
                    <span className={TEXT_MONO}>{queue.name}</span>
                  </Td>
                  <Td className={cx('text-right', TEXT_NUM)}>{queue.waiting}</Td>
                  <Td className={cx('text-right', TEXT_NUM)}>{queue.active}</Td>
                  <Td className={cx('text-right', TEXT_NUM)}>{queue.delayed}</Td>
                  <Td
                    className={cx('text-right', TEXT_NUM, queue.failed > 0 ? 'text-red-400' : null)}
                  >
                    {queue.failed}
                  </Td>
                  <Td className={cx('text-right', TEXT_NUM)}>{queue.paused}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <Panel padded={false}>
        <PanelHeader
          description={t('admin.ops.schedules.subtitle')}
          title={t('admin.ops.schedules.title')}
        />
        {data.schedules.length === 0 ? (
          <div className="p-4">
            <EmptyState>{t('admin.ops.schedules.empty')}</EmptyState>
          </div>
        ) : (
          <DataTable minWidth="52rem">
            <thead className={cx(SURFACE_HEADER, EDGE_BOTTOM)}>
              <tr>
                <Th>{t('admin.ops.schedules.job')}</Th>
                <Th>{t('admin.ops.schedules.cadence')}</Th>
                <Th>{t('admin.ops.schedules.lastRun')}</Th>
                <Th className="text-right">{t('admin.ops.schedules.duration')}</Th>
                <Th>{t('admin.ops.schedules.next')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {data.schedules.map((schedule) => (
                <ScheduleRow
                  key={`${schedule.queue}:${schedule.id}`}
                  now={now}
                  schedule={schedule}
                />
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <Panel padded={false}>
        <PanelHeader
          description={t('admin.ops.failures.subtitle', { total: data.failureTotal })}
          title={t('admin.ops.failures.title')}
        />
        {/* A shorter list that looks complete is the failure mode worth naming:
            say how many rows could not be read rather than quietly omitting
            them. */}
        {data.malformed > 0 ? (
          <div className="px-4 pt-4">
            <Alert tone="info">
              {t('admin.ops.failures.malformed', { count: data.malformed })}
            </Alert>
          </div>
        ) : null}
        {data.failures.length === 0 ? (
          <div className="p-4">
            <EmptyState>{t('admin.ops.failures.empty')}</EmptyState>
          </div>
        ) : (
          <DataTable minWidth="52rem">
            <thead className={cx(SURFACE_HEADER, EDGE_BOTTOM)}>
              <tr>
                <Th>{t('admin.ops.failures.when')}</Th>
                <Th>{t('admin.ops.failures.queue')}</Th>
                <Th>{t('admin.ops.failures.reason')}</Th>
                <Th className="text-right">{t('admin.ops.failures.attempts')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {data.failures.map((failure, index) => (
                <tr key={`${failure.at}-${failure.jobId ?? index}`}>
                  <Td className={cx('whitespace-nowrap', TEXT_NUM)}>{at(failure.at)}</Td>
                  <Td>
                    <span className={TEXT_MONO}>{failure.queue}</span>
                  </Td>
                  <Td className="text-neutral-200">{failure.failedReason}</Td>
                  <Td className={cx('text-right', TEXT_NUM)}>{failure.attemptsMade}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <div className={cx('border-t border-neutral-800 px-4 py-2.5', TEXT_MUTED)}>
          {/* Stated where the failures are, so the absence of a retry button
              reads as a decision rather than as something not built yet. */}
          {t('admin.ops.failures.readOnlyNote')}
        </div>
      </Panel>
    </div>
  );
}

function ScheduleRow({ schedule, now }: { schedule: AdminOpsSchedule; now: number }) {
  const t = useT();
  const cadence =
    schedule.pattern ??
    (schedule.everyMs === null
      ? '—'
      : t('admin.ops.schedules.every', { age: formatDuration(t, schedule.everyMs / 1000) }));

  return (
    <tr>
      <Td className="font-medium text-neutral-100">
        <span className={TEXT_MONO}>{schedule.id}</span>
      </Td>
      <Td>
        <span className={TEXT_MONO}>{cadence}</span>
        {schedule.tz ? <span className={cx(TEXT_MUTED, 'ml-2')}>{schedule.tz}</span> : null}
      </Td>
      <Td className={cx('whitespace-nowrap', TEXT_NUM)}>
        {schedule.lastRun === null ? (
          <span className={TEXT_MUTED}>{t('admin.ops.schedules.neverRun')}</span>
        ) : (
          <>
            {at(schedule.lastRun.finishedAt)}
            {schedule.lastRun.counts ? (
              <div className={cx(TEXT_MICRO, 'mt-0.5 normal-case tracking-normal')}>
                {/* The sweep's own counts, carried out of its BullMQ return
                    value. Numbers only — never a row, never an id. */}
                {Object.entries(schedule.lastRun.counts)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(' · ')}
              </div>
            ) : null}
          </>
        )}
      </Td>
      <Td className={cx('text-right', TEXT_NUM)}>
        {schedule.lastRun === null
          ? '—'
          : t('admin.ops.schedules.milliseconds', { ms: schedule.lastRun.durationMs })}
      </Td>
      <Td className={cx('whitespace-nowrap', TEXT_NUM)}>
        {relativeRun(t, schedule.nextRunAt, now)}
      </Td>
    </tr>
  );
}

/** Waiting + active + delayed + failed: how much this queue currently matters. */
function weightOf(queue: AdminOpsQueue): number {
  return queue.waiting + queue.active + queue.delayed + queue.failed + queue.paused;
}

function sum(queues: readonly AdminOpsQueue[], key: 'waiting' | 'active' | 'failed'): number {
  return queues.reduce((total, queue) => total + queue[key], 0);
}

function heartbeatTone(data: AdminOpsJobsResponse): Tone {
  if (data.heartbeatAgeSeconds === null) return 'amber';
  // The health service treats three missed intervals as stale; match it rather
  // than inventing a second, quietly different threshold.
  return data.heartbeatAgeSeconds > data.heartbeatIntervalSeconds * 3 ? 'amber' : 'green';
}
