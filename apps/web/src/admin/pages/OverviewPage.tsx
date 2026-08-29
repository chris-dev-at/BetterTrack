import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type {
  AdminBackupStatusResponse,
  AdminHealthResponse,
  AuditLogEntry,
} from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatBackupAge, formatDuration } from '../formatDuration';
import { useResource } from '../useResource';
import { Alert, Badge, Button, EmptyState, PageHeader, Spinner, cx } from '../components/ui';

/** The web bundle's own commit, baked in at build time — same marker the admin login footer shows. */
const WEB_SHA = (import.meta.env.VITE_BUILD_SHA ?? 'unknown').slice(0, 7);

/** Newest audit rows worth showing without turning the Overview into the audit page. */
const RECENT_AUDIT_LIMIT = 8;

/** A queue this deep is a signal even when the heartbeat is fine. */
const QUEUE_BACKLOG_THRESHOLD = 25;

type Severity = 'critical' | 'warn' | 'info';

const SEVERITY_TONE: Record<Severity, 'red' | 'amber' | 'sky'> = {
  critical: 'red',
  warn: 'amber',
  info: 'sky',
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

interface AttentionItem {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Right-hand figure + its unit word; omitted for items that are not a count. */
  value?: string;
  unit?: string;
  to: string;
}

/**
 * Fire `onSeen` the first time the returned ref's element is on screen, then stop
 * observing. Where `IntersectionObserver` is unavailable (jsdom, older engines)
 * it reports "seen" immediately — degrading to eager loading is the safe
 * direction: the tile still fills in, it just costs what it used to.
 */
function useObserveOnce(onSeen: (seen: true) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const seenRef = useRef(false);

  useEffect(() => {
    if (seenRef.current) return;
    const element = ref.current;
    const markSeen = () => {
      if (seenRef.current) return;
      seenRef.current = true;
      onSeen(true);
    };

    if (element === null || typeof IntersectionObserver !== 'function') {
      markSeen();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        markSeen();
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onSeen]);

  return ref;
}

/**
 * The operator Overview (#1406 W1) — the console's landing page.
 *
 * Attention first: everything that wants a human is folded into one ranked queue
 * at the top, and each row links to the workspace that resolves it. Only then
 * come the standing numbers. Every read here is an endpoint that already existed
 * before W1, with the single exception of the backup-readiness projection.
 *
 * There is no polling: an operator page that refetches on a timer is a page that
 * quietly hammers the box it is meant to watch. Refresh is explicit.
 */
export function OverviewPage() {
  const t = useT();

  // The approval-queue size rides on `/admin/stats` as a COUNT: the attention row
  // needs a number, and listing the whole queue to read `.length` would have made
  // the landing read grow with the backlog.
  const stats = useResource((signal) => api.getStats(signal), []);
  const health = useResource((signal) => api.getAdminHealth(signal), []);
  const problems = useResource((signal) => api.listProblems({ limit: 1 }, signal), []);
  const email = useResource((signal) => api.getEmailStatus(signal), []);
  const backup = useResource((signal) => api.getBackupStatus(signal), []);
  const version = useResource((signal) => api.getVersion(signal), []);
  const audit = useResource((signal) => api.listAudit({ limit: RECENT_AUDIT_LIMIT }, signal), []);

  // Usage analytics materializes TODAY's rollup server-side on every read, so it
  // is by far the most expensive call this page can make — and it feeds one tile
  // below the fold. It is therefore loaded only once that tile is actually on
  // screen: an operator who lands, reads the attention queue and leaves never
  // triggers the rollup at all.
  const [tilesSeen, setTilesSeen] = useState(false);
  const tilesRef = useObserveOnce(setTilesSeen);
  const analytics = useResource(
    (signal) => (tilesSeen ? api.getUsageAnalytics(signal) : Promise.resolve(null)),
    [tilesSeen],
  );

  const reloadAll = () => {
    stats.reload();
    health.reload();
    problems.reload();
    email.reload();
    backup.reload();
    version.reload();
    audit.reload();
    analytics.reload();
  };

  const busy =
    stats.loading ||
    health.loading ||
    problems.loading ||
    email.loading ||
    backup.loading ||
    audit.loading;

  const attention = useMemo(
    () =>
      buildAttentionQueue(t, {
        pendingRegistrations: stats.data?.pendingRegistrationCount ?? 0,
        openProblems: problems.data?.openCount ?? 0,
        health: health.data ?? null,
        smtpEnabled: email.data?.enabled ?? null,
        backup: backup.data ?? null,
      }),
    [backup.data, email.data, health.data, problems.data, stats.data, t],
  );

  // Every attention source failing at once would render a falsely calm "all
  // clear", so an unreadable queue says so instead of claiming nothing is wrong.
  const attentionUnknown =
    stats.error !== null ||
    problems.error !== null ||
    health.error !== null ||
    email.error !== null ||
    backup.error !== null;
  const attentionLoading =
    stats.loading || problems.loading || health.loading || email.loading || backup.loading;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          eyebrow={t('admin.nav.sections.overview')}
          title={t('admin.overview.title')}
          description={t('admin.overview.subtitle')}
        />
        <Button variant="secondary" onClick={reloadAll} disabled={busy}>
          {busy ? t('common.loading') : t('admin.overview.refresh')}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section
          aria-label={t('admin.overview.attention.title')}
          className={cx(
            'flex flex-col rounded-none border border-l-[3px] bg-neutral-900 lg:col-span-2',
            attention.length > 0
              ? 'border-amber-900/70 border-l-amber-500'
              : 'border-neutral-800 border-l-neutral-700',
          )}
        >
          <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2.5">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
              {t('admin.overview.attention.title')}
            </h2>
            {attention.length > 0 ? (
              <Badge tone="amber">
                {t(
                  attention.length === 1
                    ? 'admin.overview.attention.countOne'
                    : 'admin.overview.attention.countOther',
                  { count: attention.length },
                )}
              </Badge>
            ) : null}
          </div>

          {attentionLoading && attention.length === 0 ? (
            <div className="px-4 py-6">
              <Spinner label={t('common.loading')} />
            </div>
          ) : attention.length > 0 ? (
            <ul className="flex flex-col">
              {attention.map((item) => (
                <li key={item.key} className="border-b border-neutral-800 last:border-b-0">
                  <Link
                    to={item.to}
                    className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-neutral-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <Badge tone={SEVERITY_TONE[item.severity]}>
                          {t(`admin.overview.severity.${item.severity}`)}
                        </Badge>
                        <span className="truncate text-sm font-medium text-neutral-100">
                          {item.title}
                        </span>
                      </span>
                      <span className="truncate text-xs text-neutral-400">{item.detail}</span>
                    </span>
                    {item.value ? (
                      <span className="flex shrink-0 flex-col items-end">
                        <span className="text-lg font-semibold tabular-nums text-neutral-100">
                          {item.value}
                        </span>
                        {item.unit ? (
                          <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                            {item.unit}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : attentionUnknown ? (
            <div className="px-4 py-4">
              <Alert tone="error">{t('admin.overview.attention.unknown')}</Alert>
            </div>
          ) : (
            <div className="px-4 py-6">
              <EmptyState>{t('admin.overview.attention.allClear')}</EmptyState>
            </div>
          )}

          {attentionUnknown && attention.length > 0 ? (
            <div className="border-t border-neutral-800 px-4 py-3">
              <Alert tone="error">{t('admin.overview.attention.partial')}</Alert>
            </div>
          ) : null}
        </section>

        <ActivityCard
          entries={audit.data?.entries ?? []}
          error={audit.error}
          loading={audit.loading && !audit.data}
          onRetry={audit.reload}
        />
      </div>

      <section
        aria-label={t('admin.overview.tiles.title')}
        className="flex flex-col gap-3"
        ref={tilesRef}
      >
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.overview.tiles.title')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label={t('admin.overview.tiles.users')}
            loading={stats.loading && !stats.data}
            error={stats.error}
            onRetry={stats.reload}
            value={stats.data ? String(stats.data.userCount) : null}
            foot={
              stats.data
                ? t('admin.overview.tiles.usersFoot', {
                    active: stats.data.activeUserCount,
                    disabled: stats.data.disabledUserCount,
                  })
                : undefined
            }
          />
          <Tile
            label={t('admin.overview.tiles.activeUsers')}
            loading={!tilesSeen || (analytics.loading && !analytics.data)}
            error={analytics.error}
            onRetry={analytics.reload}
            value={analytics.data ? String(analytics.data.activeUsers.daily) : null}
            unit={t('admin.overview.tiles.dau')}
            foot={
              analytics.data
                ? t('admin.overview.tiles.activeUsersFoot', {
                    weekly: analytics.data.activeUsers.weekly,
                    monthly: analytics.data.activeUsers.monthly,
                  })
                : undefined
            }
          />
          <Tile
            label={t('admin.overview.tiles.gateway')}
            loading={health.loading && !health.data}
            error={health.error}
            onRetry={health.reload}
            value={health.data ? String(health.data.components.gateway.connections) : null}
            unit={t('admin.overview.tiles.sockets')}
            foot={
              health.data
                ? health.data.components.gateway.enabled
                  ? t('admin.overview.tiles.gatewayOn')
                  : t('admin.overview.tiles.gatewayOff')
                : undefined
            }
            tone={
              health.data && health.data.components.gateway.status !== 'ok' ? 'amber' : undefined
            }
          />
          <Tile
            label={t('admin.overview.tiles.uptime')}
            loading={health.loading && !health.data}
            error={health.error}
            onRetry={health.reload}
            value={health.data ? formatDuration(t, health.data.uptimeSeconds) : null}
            foot={
              health.data
                ? t('admin.overview.tiles.apiVersion', { version: health.data.version })
                : undefined
            }
            tone={health.data && health.data.status !== 'ok' ? 'amber' : undefined}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <BackupTile
            data={backup.data}
            error={backup.error}
            loading={backup.loading && !backup.data}
            onRetry={backup.reload}
          />
          <DeployStrip
            apiSha={version.data?.shortCommit ?? null}
            builtAt={version.data?.builtAt ?? null}
            error={version.error}
            loading={version.loading && !version.data}
            onRetry={version.reload}
          />
        </div>
      </section>
    </div>
  );
}

/**
 * Fold every attention source into one ranked list. Each entry is derived from a
 * read that already exists — nothing here is a new signal, only a new place to
 * see the ones the console already had scattered across five pages.
 */
function buildAttentionQueue(
  t: TranslateFn,
  input: {
    pendingRegistrations: number;
    openProblems: number;
    health: AdminHealthResponse | null;
    smtpEnabled: boolean | null;
    backup: AdminBackupStatusResponse | null;
  },
): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (input.pendingRegistrations > 0) {
    items.push({
      key: 'registrations',
      severity: 'info',
      title: t('admin.overview.attention.registrations.title'),
      detail: t('admin.overview.attention.registrations.detail'),
      value: String(input.pendingRegistrations),
      unit: t('admin.overview.attention.registrations.unit'),
      to: '/admin/registration',
    });
  }

  if (input.openProblems > 0) {
    items.push({
      key: 'problems',
      severity: 'warn',
      title: t('admin.overview.attention.problems.title'),
      detail: t('admin.overview.attention.problems.detail'),
      value: String(input.openProblems),
      unit: t('admin.overview.attention.problems.unit'),
      to: '/admin/problems',
    });
  }

  const health = input.health;
  if (health) {
    const { components } = health;
    for (const [name, component] of [
      ['database', components.database],
      ['redis', components.redis],
      ['providers', components.providers],
    ] as const) {
      if (component.status === 'ok') continue;
      items.push({
        key: `component-${name}`,
        severity: component.status === 'down' ? 'critical' : 'warn',
        title: t('admin.overview.attention.component.title', {
          component: t(`admin.health.components.${name}`),
        }),
        detail: t(`admin.health.status.${component.status}`),
        to: '/admin/health',
      });
    }

    const heartbeat = components.queues.heartbeat;
    if (components.queues.status !== 'ok') {
      items.push({
        key: 'queue-heartbeat',
        severity: components.queues.status === 'down' ? 'critical' : 'warn',
        title: t('admin.overview.attention.heartbeat.title'),
        detail:
          heartbeat.ageSeconds === null
            ? t('admin.health.queues.heartbeatUnknown')
            : t('admin.health.queues.heartbeatAge', { seconds: heartbeat.ageSeconds }),
        to: '/admin/health',
      });
    }

    const failed = components.queues.depths.reduce((sum, queue) => sum + queue.failed, 0);
    if (failed > 0) {
      items.push({
        key: 'queue-failed',
        severity: 'warn',
        title: t('admin.overview.attention.queueFailed.title'),
        detail: t('admin.overview.attention.queueFailed.detail'),
        value: String(failed),
        unit: t('admin.overview.attention.queueFailed.unit'),
        to: '/admin/health',
      });
    }

    const waiting = components.queues.depths.reduce((sum, queue) => sum + queue.waiting, 0);
    if (waiting >= QUEUE_BACKLOG_THRESHOLD) {
      items.push({
        key: 'queue-waiting',
        severity: 'warn',
        title: t('admin.overview.attention.queueBacklog.title'),
        detail: t('admin.overview.attention.queueBacklog.detail'),
        value: String(waiting),
        unit: t('admin.overview.attention.queueBacklog.unit'),
        to: '/admin/health',
      });
    }
  }

  if (input.smtpEnabled === false) {
    items.push({
      key: 'smtp',
      severity: 'warn',
      title: t('admin.overview.attention.smtp.title'),
      detail: t('admin.overview.attention.smtp.detail'),
      to: '/admin/email',
    });
  }

  if (input.backup && input.backup.level !== 'ok' && input.backup.level !== 'unknown') {
    items.push({
      key: 'backup',
      severity: input.backup.level === 'critical' ? 'critical' : 'warn',
      title: t('admin.overview.attention.backup.title'),
      detail: t(`admin.backup.reason.${input.backup.reason}`),
      to: '/admin/health',
    });
  }

  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function Tile({
  label,
  value,
  unit,
  foot,
  tone,
  loading,
  error,
  onRetry,
}: {
  label: string;
  value: string | null;
  unit?: string;
  foot?: string;
  tone?: 'amber' | 'red';
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-[96px] flex-col gap-1 rounded-none border border-l-[3px] border-neutral-800 border-l-neutral-700 bg-neutral-900 p-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
        {label}
      </span>
      {loading ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <div className="flex flex-col items-start gap-1">
          <span className="text-xs text-amber-300">
            {t('admin.overview.tiles.loadError', { tile: label })}
          </span>
          <button
            className="text-xs text-sky-400 underline underline-offset-2 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
            onClick={onRetry}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          <span
            className={cx(
              'text-xl font-semibold tabular-nums',
              tone === 'red'
                ? 'text-red-300'
                : tone === 'amber'
                  ? 'text-amber-300'
                  : 'text-neutral-100',
            )}
          >
            {value ?? '—'}
            {unit ? (
              <span className="ml-1 text-xs font-normal text-neutral-500">{unit}</span>
            ) : null}
          </span>
          {foot ? <span className="text-[11px] text-neutral-500">{foot}</span> : null}
        </>
      )}
    </div>
  );
}

/**
 * Backup / restore-drill readiness. Green means a recent dump AND a recent
 * restore drill; amber means the recovery point exists but is unproven; red
 * means there is no fresh recovery point at all (docs/ops.md 26 h / 35 d).
 */
function BackupTile({
  data,
  error,
  loading,
  onRetry,
}: {
  data: AdminBackupStatusResponse | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  const tone =
    data === null
      ? 'neutral'
      : data.level === 'ok'
        ? 'green'
        : data.level === 'warn'
          ? 'amber'
          : data.level === 'critical'
            ? 'red'
            : 'neutral';

  return (
    <div className="flex flex-col gap-2 rounded-none border border-neutral-800 bg-neutral-900 p-4 lg:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.backup.title')}
        </span>
        {data ? <Badge tone={tone}>{t(`admin.backup.level.${data.level}`)}</Badge> : null}
      </div>

      {loading ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <Alert tone="info">
          {t('admin.backup.loadError')}{' '}
          <button className="underline" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : data === null ? null : (
        <>
          {/* The reason line renders for every outcome, including the ones that
              carry no facts — "we cannot read the file" has to be sayable, and
              it must not collapse into the benign "not configured" wording. */}
          <p
            className={cx(
              'text-sm',
              data.level === 'critical' ? 'text-red-300' : 'text-neutral-400',
            )}
          >
            {t(`admin.backup.reason.${data.reason}`)}
          </p>
          {data.configured ? (
            <dl className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col">
                <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                  {t('admin.backup.lastDump')}
                </dt>
                <dd className="text-sm text-neutral-200">
                  {formatBackupAge(t, data.backup.ageSeconds)}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                  {t('admin.backup.lastDrill')}
                </dt>
                <dd className="text-sm text-neutral-200">
                  {formatBackupAge(t, data.restore.ageSeconds)}
                </dd>
              </div>
            </dl>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Which commits are live: the web bundle's build marker and the API's. */
function DeployStrip({
  apiSha,
  builtAt,
  error,
  loading,
  onRetry,
}: {
  apiSha: string | null;
  builtAt: string | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 rounded-none border border-neutral-800 bg-neutral-900 p-4">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
        {t('admin.overview.deploy.title')}
      </span>
      <div className="flex flex-col gap-1 text-[13px] text-neutral-200">
        <span>
          {t('admin.overview.deploy.web')}{' '}
          <code className="rounded-none border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] text-sky-200">
            {WEB_SHA}
          </code>
        </span>
        {loading ? (
          <Spinner label={t('common.loading')} />
        ) : error ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-amber-300">{t('admin.overview.deploy.loadError')}</span>
            <button
              className="text-xs text-sky-400 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              onClick={onRetry}
            >
              {t('common.retry')}
            </button>
          </span>
        ) : (
          <span>
            {t('admin.overview.deploy.api')}{' '}
            <code className="rounded bg-neutral-950 px-1.5 py-0.5 font-mono text-xs text-sky-200">
              {apiSha ?? '—'}
            </code>
          </span>
        )}
      </div>
      {builtAt && builtAt !== 'unknown' ? (
        <span className="text-[11px] text-neutral-500">
          {t('admin.overview.deploy.builtAt', { date: new Date(builtAt).toLocaleString() })}
        </span>
      ) : null}
    </div>
  );
}

/** The last few admin actions, humanized — action label plus what it targeted. */
function ActivityCard({
  entries,
  error,
  loading,
  onRetry,
}: {
  entries: readonly AuditLogEntry[];
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <section
      aria-label={t('admin.overview.activity.title')}
      className="flex flex-col rounded-none border border-neutral-800 bg-neutral-900"
    >
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.overview.activity.title')}
        </h2>
        <Link
          className="text-[12px] text-sky-400 underline underline-offset-2 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
          to="/admin/audit"
        >
          {t('admin.overview.activity.viewAll')}
        </Link>
      </div>

      {loading ? (
        <div className="px-4 py-6">
          <Spinner label={t('common.loading')} />
        </div>
      ) : error ? (
        <div className="px-4 py-4">
          <Alert tone="info">
            {t('admin.overview.activity.loadError')}{' '}
            <button className="underline" onClick={onRetry}>
              {t('common.retry')}
            </button>
          </Alert>
        </div>
      ) : entries.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState>{t('admin.overview.activity.empty')}</EmptyState>
        </div>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-0.5 border-b border-neutral-800 px-4 py-2 last:border-b-0"
            >
              <span className="text-xs text-neutral-200">{humanizeAction(entry.action)}</span>
              <span className="text-[11px] text-neutral-500">
                {entry.targetType
                  ? `${entry.targetType} · ${new Date(entry.createdAt).toLocaleString()}`
                  : new Date(entry.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * `user.disable` → `User disable`. Audit actions are server-authored identifiers
 * with an open vocabulary, so they cannot come from the message catalog; this
 * makes them readable without inventing copy that claims more than the tag does.
 */
function humanizeAction(action: string): string {
  const words = action.replace(/[._-]+/g, ' ').trim();
  return words.length === 0 ? action : words.charAt(0).toUpperCase() + words.slice(1);
}
