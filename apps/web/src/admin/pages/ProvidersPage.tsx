import { useCallback } from 'react';

import type {
  AdminHealthResponse,
  AdminOpsBreaker,
  AdminOpsProvider,
  AdminOpsProvidersResponse,
  HealthCircuitState,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useLiveRefresh } from '../useLiveRefresh';
import { useResource } from '../useResource';
import { LiveRefreshControl } from '../components/LiveRefreshControl';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import {
  EDGE_BOTTOM,
  SURFACE_HEADER,
  TEXT_MONO,
  TEXT_MUTED,
  TEXT_NUM,
  type Tone,
} from '../components/tokens';
import {
  Alert,
  AsyncReadState,
  Badge,
  DataTable,
  EmptyState,
  KeyValueList,
  PageHeader,
  Panel,
  PanelHeader,
  StatTile,
  Td,
  Th,
  cx,
} from '../components/ui';

/**
 * Operations → Providers (#1406 W4).
 *
 * `/admin/health` reports one breaker state per upstream — the WORST across its
 * capabilities. That is the right summary for a health tile and exactly the
 * wrong thing for diagnosis, because it hides the property the per-capability
 * isolation was built for: a dead `fundamentals` module must not make `quote`
 * look broken (§13.5 V5-P1c, #1552). This page is that missing dimension.
 *
 * Two absences are deliberate and are stated on the page rather than left
 * looking unfinished:
 *
 *  - **No quota gauge.** The upstream is keyless; there is no authoritative
 *    quota to draw, and the #1406 DECISION rejected inventing one. The honest
 *    signal for throttling is a breaker that a 429 tripped immediately.
 *  - **No reset button.** A breaker is a safety valve on someone else's
 *    service. Forcing it closed re-opens the flood the valve exists to stop;
 *    the cooldown, and the half-open probe, are the intended recovery.
 */

const CIRCUIT_TONE: Record<HealthCircuitState, Tone> = {
  closed: 'green',
  'half-open': 'amber',
  open: 'red',
};

function percent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)} %`;
}

function at(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

export function ProvidersPage() {
  const t = useT();

  const providers = useResource((signal) => api.getOpsProviders(signal), []);
  const health = useResource((signal) => api.getAdminHealth(signal), []);

  const reloadAll = useCallback(() => {
    providers.reload();
    health.reload();
  }, [providers, health]);

  const live = useLiveRefresh(reloadAll);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        actions={<LiveRefreshControl busy={providers.loading || health.loading} live={live} />}
        description={t('admin.ops.providers.subtitle')}
        eyebrow={t('admin.nav.sections.operations')}
        title={t('admin.ops.providers.title')}
      />
      <WorkspaceTabs />

      <section aria-busy={providers.loading} aria-label={t('admin.ops.providers.title')}>
        {providers.loading || providers.error ? (
          <AsyncReadState
            error={providers.error}
            loading={providers.loading && providers.data === null}
            onRetry={providers.reload}
            retryable={providers.retryable}
          />
        ) : null}
        {providers.data ? <ProvidersBody data={providers.data} /> : null}
      </section>

      {/* The failover attribution is a second read, so it gets its own loading
          and error states rather than silently rendering nothing while it is in
          flight — "no failover configured" and "the failover read has not
          answered" look identical otherwise. */}
      <section aria-busy={health.loading} aria-label={t('admin.health.failover.title')}>
        {health.loading || health.error ? (
          <AsyncReadState
            error={health.error}
            loading={health.loading && health.data === null}
            onRetry={health.reload}
            retryable={health.retryable}
          />
        ) : null}
        {health.data ? <FailoverPanel providers={health.data.components.providers} /> : null}
      </section>
    </div>
  );
}

function ProvidersBody({ data }: { data: AdminOpsProvidersResponse }) {
  const t = useT();

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          detail={t('admin.ops.cache.hitDetail')}
          label={t('admin.ops.cache.hitRate')}
          tone={data.cache.hitRate !== null && data.cache.hitRate < 0.5 ? 'amber' : 'neutral'}
          value={percent(data.cache.hitRate)}
        />
        <StatTile
          detail={t('admin.ops.cache.staleDetail')}
          label={t('admin.ops.cache.staleRate')}
          tone={data.cache.staleRate !== null && data.cache.staleRate > 0.2 ? 'amber' : 'neutral'}
          value={percent(data.cache.staleRate)}
        />
        <StatTile label={t('admin.ops.cache.lookups')} value={data.cache.total} />
        <StatTile
          detail={t('admin.ops.providers.sampledSince', {
            time: new Date(data.sampledSince).toLocaleString(),
          })}
          label={t('admin.ops.cache.negative')}
          value={data.cache.negative}
        />
      </div>

      {/* The caveat that makes every number above readable, said once, plainly. */}
      <Alert tone="info">{t('admin.ops.providers.processLocalNote')}</Alert>

      {data.providers.length === 0 ? (
        <EmptyState>{t('admin.health.providers.none')}</EmptyState>
      ) : (
        data.providers.map((provider) => (
          <ProviderPanel key={provider.providerId} provider={provider} />
        ))
      )}
    </div>
  );
}

function ProviderPanel({ provider }: { provider: AdminOpsProvider }) {
  const t = useT();

  return (
    <Panel padded={false}>
      <PanelHeader
        actions={
          <Badge tone={CIRCUIT_TONE[provider.state]}>
            {t(`admin.health.circuit.${provider.state}`)}
          </Badge>
        }
        description={t('admin.ops.providers.callsSummary', {
          success: provider.calls.success,
          error: provider.calls.error,
          shortCircuited: provider.calls.circuitOpen,
        })}
        title={provider.providerId}
      />
      {provider.capabilities.length === 0 ? (
        <div className="p-4">
          {/* Absent, not "closed": a capability nobody has called has no breaker,
              and reporting it as healthy would be a claim nothing supports. */}
          <EmptyState>{t('admin.ops.providers.noCapabilityCalls')}</EmptyState>
        </div>
      ) : (
        <DataTable minWidth="52rem">
          <thead className={cx(SURFACE_HEADER, EDGE_BOTTOM)}>
            <tr>
              <Th>{t('admin.ops.providers.capability')}</Th>
              <Th>{t('admin.ops.providers.breaker')}</Th>
              <Th className="text-right">{t('admin.ops.providers.failures')}</Th>
              <Th>{t('admin.ops.providers.lastError')}</Th>
              <Th>{t('admin.ops.providers.retryAt')}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {provider.capabilities.map((capability) => (
              <CapabilityRow capability={capability} key={capability.capability} />
            ))}
          </tbody>
        </DataTable>
      )}
    </Panel>
  );
}

function CapabilityRow({ capability }: { capability: AdminOpsBreaker }) {
  const t = useT();

  return (
    <tr>
      <Td className="font-medium text-neutral-100">
        <span className={TEXT_MONO}>{capability.capability}</span>
      </Td>
      <Td>
        <Badge tone={CIRCUIT_TONE[capability.state]}>
          {t(`admin.health.circuit.${capability.state}`)}
        </Badge>
      </Td>
      <Td className={cx('text-right', TEXT_NUM)}>
        {/* Failures out of the threshold, so "3" reads as "two more to go"
            rather than as a bare number with no scale. */}
        {capability.consecutiveFailures} / {capability.failureThreshold}
      </Td>
      <Td className="text-neutral-200">
        {capability.lastError ?? <span className={TEXT_MUTED}>—</span>}
        {capability.lastErrorAt ? (
          <div className={cx(TEXT_MUTED, TEXT_NUM)}>{at(capability.lastErrorAt)}</div>
        ) : null}
      </Td>
      <Td className={cx('whitespace-nowrap', TEXT_NUM)}>
        {capability.retryAt === null ? (
          <span className={TEXT_MUTED}>—</span>
        ) : (
          <span className="text-amber-400">{at(capability.retryAt)}</span>
        )}
      </Td>
    </tr>
  );
}

/**
 * Provider failover attribution (§13.5 V5-P1c), moved here from Health by W4 so
 * every provider signal is in one place. Renders nothing until a secondary is
 * configured and has served traffic, so a single-provider deploy sees no chrome.
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
    <Panel padded={false}>
      <PanelHeader title={t('admin.health.failover.title')} />
      <div className="flex flex-col gap-3 p-4">
        {chains.length > 0 ? (
          <ul className={cx('flex flex-col gap-1', TEXT_MUTED)}>
            {chains.map((chain) => {
              const failedOver = chain.serving !== null && chain.serving !== chain.primaryId;
              return (
                // A primary can report more than one chain when its asset classes
                // route differently, so the candidate list is what makes it unique.
                <li
                  className="flex flex-wrap items-center gap-2"
                  key={`${chain.primaryId}:${chain.providerIds.join('>')}`}
                >
                  <span className={cx(TEXT_MONO, 'text-neutral-200')}>
                    {chain.providerIds.join(' → ')}
                  </span>
                  {chain.serving ? (
                    <Badge tone={failedOver ? 'amber' : 'green'}>{chain.serving}</Badge>
                  ) : null}
                  {failedOver ? <span>{t('admin.health.failover.viaFailover')}</span> : null}
                  {chain.since ? (
                    <span>
                      {t('admin.health.failover.since', {
                        time: new Date(chain.since).toLocaleTimeString(),
                      })}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {attribution.length > 0 ? (
          <KeyValueList
            rows={attribution.map((entry) => ({
              label: entry.providerId,
              value: t('admin.health.failover.served', { count: entry.serves }),
            }))}
          />
        ) : null}

        <div className="flex flex-col gap-1">
          <span className={TEXT_MUTED}>{t('admin.health.failover.switchesTitle')}</span>
          {switches.length === 0 ? (
            <span className={TEXT_MUTED}>{t('admin.health.failover.noSwitches')}</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {switches.slice(0, 5).map((entry, index) => (
                <li className={cx(TEXT_MONO, 'text-neutral-300')} key={`${entry.at}-${index}`}>
                  {entry.from ?? '—'} → {entry.to} · {new Date(entry.at).toLocaleTimeString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
