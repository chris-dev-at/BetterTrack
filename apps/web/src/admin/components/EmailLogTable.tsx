import { useCallback, useEffect, useState } from 'react';

import type { EmailLogEntry, EmailLogListResponse } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { formatDateTime } from '../format';
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
 */
export function EmailLogTable({ load, emptyLabel }: { load: EmailLogLoader; emptyLabel?: string }) {
  const [entries, setEntries] = useState<EmailLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      }
    },
    [load],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchPage(null, controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [fetchPage]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    await fetchPage(cursor);
    setLoadingMore(false);
  }

  if (loading) return <Spinner label="Loading email log…" />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (entries.length === 0) return <EmptyState>{emptyLabel ?? 'No emails sent yet.'}</EmptyState>;

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Recipient</th>
              <th className="px-4 py-3 font-medium">Template</th>
              <th className="px-4 py-3 font-medium">Subject</th>
              <th className="px-4 py-3 font-medium">Status</th>
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
                    {entry.status}
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
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
