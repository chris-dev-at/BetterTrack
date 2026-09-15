import { useCallback, useEffect, useState } from 'react';

import type { EmailLogEntry, EmailLogListResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import { useAdminCallFailure } from '../sessionExpiry';
import { Alert, Badge, Button, EmptyState, Spinner } from './ui';

type StatusTone = 'green' | 'red' | 'neutral';
const STATUS_TONE: Record<EmailLogEntry['status'], StatusTone> = {
  sent: 'green',
  failed: 'red',
  suppressed: 'neutral',
};

/** Load one page of the log; used for both the global and per-user views. */
export type EmailLogLoader = (
  params: { cursor?: string },
  signal?: AbortSignal,
) => Promise<EmailLogListResponse>;

/**
 * Email send-log table (PROJECTPLAN.md §6.10, §6.12). Cursor-paged, newest
 * first; renders recipient, template, subject, status and time — never a body.
 * The parent supplies `load` (global or per-user), so the same table serves the
 * Email page and the per-user modal.
 *
 * Failures go through the same two rules as every sibling reader (#1814): a
 * closed admin session window signs the console out instead of leaving the
 * operator on a dead page, and anything displayable is catalog copy — the
 * server's envelope is authored in English and would leak into a German
 * console.
 */
export function EmailLogTable({ load, emptyLabel }: { load: EmailLogLoader; emptyLabel?: string }) {
  const t = useT();
  const [entries, setEntries] = useState<EmailLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // A FLAG, not a message: the copy is looked up at render time, so switching
  // the console's language re-translates the banner without refetching the log.
  // Every displayable failure resolves to the same catalog line — server
  // envelopes are English-only and never reach the DOM (#1814).
  const [failed, setFailed] = useState(false);
  const onFailure = useAdminCallFailure();

  const fetchPage = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      try {
        const page = await load(after ? { cursor: after } : {}, signal);
        if (signal?.aborted) return;
        setEntries((prev) => (after ? [...prev, ...page.entries] : page.entries));
        setCursor(page.nextCursor);
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // This table addresses a whole surface, not a row, so a 404 is the
        // §6.12 "not an admin here any more" answer — the read-path rule.
        if (onFailure(err)) return;
        setFailed(true);
      }
    },
    [load, onFailure],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void fetchPage(null, controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [fetchPage]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setFailed(false);
    await fetchPage(cursor);
    setLoadingMore(false);
  }

  if (loading) return <Spinner label={t('admin.emailLog.loading')} />;
  if (failed) return <Alert tone="error">{t('common.genericError')}</Alert>;
  if (entries.length === 0)
    return <EmptyState>{emptyLabel ?? t('admin.emailLog.empty')}</EmptyState>;

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="px-4 py-3 font-medium">{t('admin.emailLog.headers.when')}</th>
              <th className="px-4 py-3 font-medium">{t('admin.emailLog.headers.recipient')}</th>
              <th className="px-4 py-3 font-medium">{t('admin.emailLog.headers.template')}</th>
              <th className="px-4 py-3 font-medium">{t('admin.emailLog.headers.subject')}</th>
              <th className="px-4 py-3 font-medium">{t('admin.emailLog.headers.status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {entries.map((entry) => (
              <tr key={entry.id} className="hover:bg-neutral-900/50">
                <td className="whitespace-nowrap px-4 py-3 text-neutral-400">
                  {formatDateTime(entry.createdAt)}
                </td>
                <td className="px-4 py-3 text-neutral-200">{entry.recipient}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-400">{entry.template}</td>
                <td className="max-w-xs truncate px-4 py-3 text-neutral-400" title={entry.subject}>
                  {entry.subject}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={STATUS_TONE[entry.status]}>
                    {t(`admin.emailLog.status.${entry.status}`)}
                    {entry.errorCode ? ` · ${entry.errorCode}` : ''}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? t('admin.emailLog.loadingMore') : t('admin.emailLog.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
