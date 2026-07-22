import { useCallback, useState } from 'react';

import type { AdminFeatureFlag, FeatureFlagKey } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../format';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner } from '../components/ui';

/**
 * Admin feature kill-switches (PROJECTPLAN.md §13.5 V5-P2 arc (c)). Lists the
 * runtime flags — realtime, live mode, chat, alerts, imports, AI — with an
 * on/off toggle each. A flip is read per request, so the gated surface refuses
 * (and the SPA hides it) on the very next request, no redeploy. Every flag's
 * name + description is localized through `admin.featureFlags.flag.*`; the
 * server's English metadata is not rendered.
 */
export function FeatureFlagsPage() {
  const t = useT();
  const [busyKey, setBusyKey] = useState<FeatureFlagKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flags, setFlags] = useState<AdminFeatureFlag[] | null>(null);

  const resource = useResource((signal) => api.getFeatureFlags(signal), []);
  const { loading, error, reload } = resource;
  // Prefer the optimistic post-toggle list, falling back to the fetched one.
  const rows = flags ?? resource.data?.flags ?? null;

  const toggle = useCallback(
    async (key: FeatureFlagKey, enabled: boolean) => {
      setBusyKey(key);
      setActionError(null);
      try {
        const next = await api.setFeatureFlag(key, enabled);
        setFlags(next.flags);
      } catch {
        setActionError(t('admin.featureFlags.actionError'));
      } finally {
        setBusyKey(null);
      }
    },
    [t],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <PageHeader
          title={t('admin.featureFlags.title')}
          description={t('admin.featureFlags.subtitle')}
        />
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            setFlags(null);
            reload();
          }}
        >
          {t('admin.featureFlags.refresh')}
        </Button>
      </div>

      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {loading && !rows ? (
        <Spinner label={t('admin.featureFlags.title')} />
      ) : error && !rows ? (
        <Alert tone="error">
          {t('admin.featureFlags.loadError')}{' '}
          <button className="underline" onClick={reload}>
            {t('admin.featureFlags.refresh')}
          </button>
        </Alert>
      ) : rows ? (
        <div className="overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">{t('admin.featureFlags.featureColumn')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.featureFlags.stateColumn')}</th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.featureFlags.lastChangedColumn')}
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {rows.map((flag) => (
                <tr key={flag.key} className="align-top hover:bg-neutral-900/60">
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-neutral-100">
                        {t(`admin.featureFlags.flag.${flag.key}.name`)}
                      </span>
                      <span className="text-sm text-neutral-500">
                        {t(`admin.featureFlags.flag.${flag.key}.description`)}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={flag.enabled ? 'green' : 'neutral'}>
                      {flag.enabled ? t('admin.featureFlags.on') : t('admin.featureFlags.off')}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs text-neutral-400">
                    {flag.updatedAt
                      ? formatDateTime(flag.updatedAt)
                      : t('admin.featureFlags.never')}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      variant="secondary"
                      disabled={busyKey === flag.key}
                      onClick={() => void toggle(flag.key, !flag.enabled)}
                    >
                      {flag.enabled
                        ? t('admin.featureFlags.disable')
                        : t('admin.featureFlags.enable')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
