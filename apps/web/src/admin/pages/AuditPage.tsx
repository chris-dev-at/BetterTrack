import { useCallback, useEffect, useState } from 'react';

import type { AuditLogEntry } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { isAdminTwoFactorSetupRequired, useAuth } from '../AuthContext';
import { adminSignOutReason } from '../sessionExpiry';
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
  // Failures are recorded as a FLAG, not as a message (#1848). The message is
  // chosen at render time from the catalogue, so it is in the reader's locale
  // and stays right when the locale changes under an error that is on screen.
  const [initialError, setInitialError] = useState(false);
  const [paginationError, setPaginationError] = useState(false);

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
          // Same 401-or-404 rule as `useResource`, and the same reason: on the
          // admin origin this is normally the V5-P13c window closing, so the login
          // screen names it instead of bouncing silently — unless the 404 named a
          // domain outcome, which is a row talking and not this session.
          clearSession(adminSignOutReason(err));
          return;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return;
        }
        // API envelopes are authored by the server and are not locale-aware —
        // the rule `useResource` states and this page was the console's last
        // offender against (#1814, #1848). Nothing the server wrote is shown.
        if (after) setPaginationError(true);
        else setInitialError(true);
      }
    },
    [clearSession, requireTwoFactorSetup],
  );

  const loadInitial = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setInitialError(false);
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
    setPaginationError(false);
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
      <PageHeader title={t('admin.audit.title')} description={t('admin.audit.subtitle')} />

      {loading ? (
        <Spinner label={t('admin.audit.loading')} />
      ) : initialError ? (
        errorMessage(t('admin.audit.loadError'), retryInitial)
      ) : entries.length === 0 ? (
        <EmptyState>{t('admin.audit.empty')}</EmptyState>
      ) : (
        <>
          {paginationError ? errorMessage(t('admin.audit.loadMoreError'), loadMore) : null}
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('admin.audit.columns.when')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.audit.columns.action')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.audit.columns.actor')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.audit.columns.target')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.audit.columns.ip')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.audit.columns.details')}</th>
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
                      {entry.actorId ?? t('admin.audit.actorSystem')}
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
                {loadingMore ? t('admin.audit.loadingMore') : t('admin.audit.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
