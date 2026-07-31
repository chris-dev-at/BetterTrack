import { useCallback, useEffect, useState } from 'react';

import type { AuditLogEntry } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { isAdminTwoFactorSetupRequired, useAuth } from '../AuthContext';
import { formatDateTime } from '../../lib/format';
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
  const t = useT();
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [paginationError, setPaginationError] = useState<string | null>(null);

  const loadPage = useCallback(
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
        const message = err instanceof ApiError ? err.message : 'Something went wrong.';
        if (after) {
          setPaginationError(message);
        } else {
          setInitialError(message);
        }
      }
    },
    [clearSession, requireTwoFactorSetup],
  );

  const loadInitial = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setInitialError(null);
      await loadPage(null, signal);
      if (!signal?.aborted) setLoading(false);
    },
    [loadPage],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadInitial(controller.signal);
    return () => controller.abort();
  }, [loadInitial]);

  async function retryInitial() {
    await loadInitial();
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setPaginationError(null);
    await loadPage(cursor);
    setLoadingMore(false);
  }

  const retryAction = (onClick: () => Promise<void>) => (
    <Button variant="secondary" onClick={() => void onClick()}>
      {t('common.retry')}
    </Button>
  );

  const errorMessage = (message: string, onRetry: () => Promise<void>) => (
    <Alert tone="error">
      <div className="flex items-center justify-between gap-3">
        <span>{message}</span>
        {retryAction(onRetry)}
      </div>
    </Alert>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every administrative and security-relevant action."
      />

      {loading ? (
        <Spinner label="Loading audit log…" />
      ) : initialError ? (
        errorMessage(initialError, retryInitial)
      ) : entries.length === 0 ? (
        <EmptyState>No audit entries yet.</EmptyState>
      ) : (
        <>
          {paginationError ? errorMessage(paginationError, loadMore) : null}
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
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
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                      {entry.actorId ?? 'system'}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {entry.targetType ? (
                        <span>
                          {entry.targetType}
                          {entry.targetId ? (
                            <span className="font-mono text-xs text-neutral-400">
                              {' '}
                              {entry.targetId}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                      {entry.ip ?? '—'}
                    </td>
                    <td
                      className="max-w-xs truncate px-4 py-3 text-neutral-400"
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
