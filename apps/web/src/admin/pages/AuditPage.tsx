import { useCallback, useEffect, useState } from 'react';

import type { AuditLogEntry } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { isAdminTwoFactorSetupRequired, useAuth } from '../AuthContext';
import { formatDateTime } from '../format';
import { Alert, Button, EmptyState, PageHeader, Spinner } from '../components/ui';

/** Compact one-line rendering of an audit entry's freeform metadata. */
function metaSummary(meta: unknown): string {
  if (meta === null || meta === undefined) return '—';
  if (typeof meta === 'string') return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return '—';
  }
}

export function AuditPage() {
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      try {
        const page = await api.listAudit(after ? { cursor: after } : {}, signal);
        if (signal?.aborted) return;
        setEntries((prev) => (after ? [...prev, ...page.entries] : page.entries));
        setCursor(page.nextCursor);
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.isNotAuthorized) {
          clearSession();
          return;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      }
    },
    [clearSession, requireTwoFactorSetup],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void load(null, controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    await load(cursor);
    setLoadingMore(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every administrative and security-relevant action."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {loading ? (
        <Spinner label="Loading audit log…" />
      ) : entries.length === 0 ? (
        <EmptyState>No audit entries yet.</EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Actor</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">IP</th>
                  <th className="px-4 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-neutral-900/50">
                    <td className="whitespace-nowrap px-4 py-3 text-neutral-400">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className="px-4 py-3 font-medium text-neutral-200">{entry.action}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                      {entry.actorId ?? 'system'}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {entry.targetType ? (
                        <span>
                          {entry.targetType}
                          {entry.targetId ? (
                            <span className="font-mono text-xs text-neutral-500">
                              {' '}
                              {entry.targetId}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                      {entry.ip ?? '—'}
                    </td>
                    <td
                      className="max-w-xs truncate px-4 py-3 text-neutral-500"
                      title={metaSummary(entry.meta)}
                    >
                      {metaSummary(entry.meta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor ? (
            <div className="flex justify-center">
              <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
