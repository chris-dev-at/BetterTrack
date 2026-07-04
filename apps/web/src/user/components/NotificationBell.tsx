import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import type { MarkReadRequest, Notification } from '@bettertrack/contracts';

import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, cx } from './ui';

const POLL_INTERVAL_MS = 30_000;
const NOTIFICATIONS_QUERY_KEY = ['notifications'];

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** ISO timestamp → short relative label ("5m ago", "in 2h" never occurs — all past). */
function formatRelativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 60) return relativeTimeFormatter.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return relativeTimeFormatter.format(diffHours, 'hour');
  const diffDays = Math.round(diffHours / 24);
  return relativeTimeFormatter.format(diffDays, 'day');
}

function NotificationRow({
  notification,
  onRead,
}: {
  notification: Notification;
  onRead: () => void;
}) {
  const unread = notification.readAt === null;
  return (
    <li>
      <button
        type="button"
        onClick={onRead}
        className={cx(
          'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-neutral-800',
          unread ? 'bg-neutral-800/60' : undefined,
        )}
      >
        <span className="flex items-center gap-2">
          {unread ? (
            <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full bg-sky-400" />
          ) : null}
          <span
            className={cx(
              'truncate text-sm font-medium',
              unread ? 'text-neutral-100' : 'text-neutral-400',
            )}
          >
            {notification.title}
          </span>
        </span>
        <span className="truncate text-xs text-neutral-500">{notification.body}</span>
        <span className="text-[0.65rem] uppercase tracking-wide text-neutral-600">
          {formatRelativeTime(notification.createdAt)}
        </span>
      </button>
    </li>
  );
}

/**
 * Notification bell (PROJECTPLAN.md §6.10, §7.4) — unread badge, dropdown list,
 * mark-read/mark-all. V1 freshness is TanStack Query polling + refocus-refetch
 * (no sockets); the full list lives in Settings → Notifications (P7).
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: ({ signal }) => listNotifications({}, signal),
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const markReadMutation = useMutation({
    mutationFn: (body: MarkReadRequest) => markNotificationsRead(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    },
  });

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const unreadCount = query.data?.unreadCount ?? 0;
  const items = query.data?.items ?? [];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        className="relative grid h-9 w-9 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <path d="M18 16v-5a6 6 0 1 0-12 0v5l-1.5 2.5h15z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-sky-500 px-1 text-[0.625rem] font-semibold leading-none text-white ring-2 ring-neutral-900"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
            <span className="text-sm font-medium text-neutral-200">Notifications</span>
            <button
              type="button"
              onClick={() => markReadMutation.mutate({ all: true })}
              disabled={unreadCount === 0 || markReadMutation.isPending}
              className="text-xs font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              Mark all read
            </button>
          </div>

          {markReadMutation.isError ? (
            <div className="px-3 pt-2">
              <Alert tone="error">Couldn't update that notification. Please try again.</Alert>
            </div>
          ) : null}

          {query.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton height="h-12" />
              <Skeleton height="h-12" />
              <Skeleton height="h-12" />
            </div>
          ) : query.isError && items.length === 0 ? (
            <EmptyState
              title="Couldn't load notifications"
              description="Please try again in a moment."
              className="py-10"
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon="🔔"
              title="No notifications yet"
              description="Activity like friend requests and shares will show up here."
              className="py-10"
            />
          ) : (
            <ul className="max-h-96 divide-y divide-neutral-800 overflow-y-auto">
              {items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onRead={() => {
                    if (notification.readAt === null) {
                      markReadMutation.mutate({ ids: [notification.id] });
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
