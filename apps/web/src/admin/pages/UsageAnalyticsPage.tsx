import type { UsageFunnelStage } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner } from '../components/ui';

/**
 * Admin **Usage Analytics** page (PROJECTPLAN.md §13.5 V5-P2 arc (b)). Renders
 * DAU/WAU/MAU, per-feature usage counters, top viewed assets and the
 * registration funnel — all first-party, computed from our own request/auth
 * stream (no third-party trackers). All copy is localized through
 * `admin.usageAnalytics.*`; the feature and funnel labels fall back to the raw
 * key when a bucket has no translation yet.
 */
export function UsageAnalyticsPage() {
  const t = useT();
  const resource = useResource((signal) => api.getUsageAnalytics(signal), []);
  const { data, loading, error, reload } = resource;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={t('admin.usageAnalytics.title')}
          description={t('admin.usageAnalytics.subtitle')}
        />
        <Button variant="secondary" onClick={reload}>
          {t('admin.usageAnalytics.refresh')}
        </Button>
      </div>

      {loading && !data ? <Spinner label={t('common.loading')} /> : null}
      {error ? <Alert tone="error">{t('admin.usageAnalytics.loadError')}</Alert> : null}

      {data ? (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile label={t('admin.usageAnalytics.dau')} value={data.activeUsers.daily} />
            <StatTile label={t('admin.usageAnalytics.wau')} value={data.activeUsers.weekly} />
            <StatTile label={t('admin.usageAnalytics.mau')} value={data.activeUsers.monthly} />
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel title={t('admin.usageAnalytics.funnel')}>
              <Funnel points={data.funnel} />
            </Panel>

            <Panel
              title={t('admin.usageAnalytics.features')}
              hint={t('admin.usageAnalytics.windowHint', { days: data.windowDays })}
            >
              {data.features.length === 0 ? (
                <Empty>{t('admin.usageAnalytics.noData')}</Empty>
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.features.map((f) => (
                    <li
                      key={f.feature}
                      className="flex items-center justify-between text-sm text-neutral-200"
                    >
                      <span>{featureLabel(t, f.feature)}</span>
                      <Badge tone="sky">{f.events}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title={t('admin.usageAnalytics.topAssets')}
              hint={t('admin.usageAnalytics.windowHint', { days: data.windowDays })}
            >
              {data.topAssets.length === 0 ? (
                <Empty>{t('admin.usageAnalytics.noData')}</Empty>
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.topAssets.map((a) => (
                    <li
                      key={a.assetId}
                      className="flex items-center justify-between text-sm text-neutral-200"
                    >
                      <span className="truncate font-mono text-neutral-300">{a.assetId}</span>
                      <Badge tone="sky">
                        {t('admin.usageAnalytics.views', { count: a.views })}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title={t('admin.usageAnalytics.activity')}
              hint={t('admin.usageAnalytics.windowHint', { days: data.windowDays })}
            >
              {data.series.length === 0 ? (
                <Empty>{t('admin.usageAnalytics.noData')}</Empty>
              ) : (
                <ActivitySeries
                  points={data.series}
                  eventsLabel={t('admin.usageAnalytics.eventsLabel')}
                  usersLabel={t('admin.usageAnalytics.activeUsersLabel')}
                />
              )}
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-100">{value}</div>
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-neutral-100">{title}</h3>
        {hint ? <span className="text-xs text-neutral-500">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutral-500">{children}</p>;
}

function Funnel({ points }: { points: { stage: UsageFunnelStage; count: number }[] }) {
  const t = useT();
  const top = points[0]?.count ?? 0;
  return (
    <ul className="flex flex-col gap-2">
      {points.map((p) => {
        const pct = top > 0 ? Math.round((p.count / top) * 100) : 0;
        return (
          <li key={p.stage} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-sm text-neutral-200">
              <span>{t(`admin.usageAnalytics.stage.${p.stage}`)}</span>
              <span className="text-neutral-400">{p.count}</span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-neutral-800">
              <div className="h-full rounded bg-sky-500" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ActivitySeries({
  points,
  eventsLabel,
  usersLabel,
}: {
  points: { day: string; events: number; activeUsers: number }[];
  eventsLabel: string;
  usersLabel: string;
}) {
  const max = points.reduce((m, p) => Math.max(m, p.events), 0);
  return (
    <div className="flex h-32 items-end gap-1" role="img" aria-label={eventsLabel}>
      {points.map((p) => {
        const pct = max > 0 ? Math.max(4, Math.round((p.events / max) * 100)) : 4;
        return (
          <div
            key={p.day}
            className="flex-1 rounded-t bg-sky-500/70"
            style={{ height: `${pct}%` }}
            title={`${p.day} · ${eventsLabel}: ${p.events} · ${usersLabel}: ${p.activeUsers}`}
          />
        );
      })}
    </div>
  );
}

/** Localized feature label, falling back to the raw bucket key. */
function featureLabel(t: (key: string) => string, feature: string): string {
  const key = `admin.usageAnalytics.feature.${feature}`;
  const label = t(key);
  return label === key ? feature : label;
}
