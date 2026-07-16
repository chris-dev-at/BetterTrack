import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { REALTIME_SERVER_EVENTS } from '@bettertrack/contracts';
import type { MarkReadRequest, Notification } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getFormatLocale } from '../../lib/format';
import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { useRealtimeEvent } from '../../lib/realtime';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, cx } from './ui';

/** Read a string field from a notification payload, or null when absent/empty. */
function payloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object' && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

const enc = encodeURIComponent;

/**
 * The in-app deep link for a notification — the canonical route-key contract
 * (V4-P0c). EVERY notification type click-navigates to its target, keyed off
 * `type` plus the id(s) the dispatcher stamps into the row payload; the FCM
 * `data` map (docs/mobile-push.md §4) carries the same ids so the app deep-links
 * identically. When the id an entry needs is missing (a legacy row from before a
 * key existed) the function falls back to the type's landing surface rather than
 * returning null, so no notification is ever a dead click.
 */
function notificationLink(notification: Notification): string | null {
  const p = notification.payload;
  switch (notification.type) {
    // Price alerts (own + followed) → the asset the alert watches (§14, #455).
    case 'alert.triggered':
    case 'follow.alert.created':
    case 'follow.alert.fired': {
      const assetId = payloadString(p, 'assetId');
      return assetId ? `/assets/${enc(assetId)}` : '/workboard/alerts';
    }
    // Friend request → the requests section of the Friends tab (V4-P0b).
    case 'friend.request':
      return '/social/friends#requests';
    case 'friend.accepted':
      return '/social/friends';
    // Shared items → the recipient's Shared-With-Me view for that item.
    case 'portfolio.shared': {
      const id = payloadString(p, 'portfolioId');
      return id ? `/social/shared-with-me/${enc(id)}` : '/social/friends';
    }
    case 'watchlist.shared': {
      const id = payloadString(p, 'watchlistId');
      return id ? `/social/shared-with-me/watchlists/${enc(id)}` : '/social/friends';
    }
    case 'conglomerate.shared': {
      const id = payloadString(p, 'conglomerateId');
      return id ? `/social/shared-with-me/conglomerates/${enc(id)}` : '/social/friends';
    }
    // Friend activity + newly-published items → the actor's public profile (#438).
    case 'friend.activity':
    case 'follow.published': {
      const username = payloadString(p, 'actorUsername');
      return username ? `/u/${enc(username)}` : '/social/friends';
    }
    // Chat → the DM thread (scroll-to-message is the thread page's concern).
    case 'chat.message': {
      const conversationId = payloadString(p, 'conversationId');
      return conversationId ? `/social/chat/c/${enc(conversationId)}` : '/social/chat';
    }
    // Account/security → the matching settings page.
    case 'account.temp_password':
      return '/settings/security';
    case 'account.invite':
      return '/settings/account';
    // Data export ready (V4-P6a) → the export block in Settings → Account.
    case 'account.data_export':
      return '/settings/account';
    // The one-off lean-email-defaults notice (V4-P0c) → the matrix it explains.
    case 'account.notice':
      return '/settings/notifications';
    default:
      return null;
  }
}

const POLL_INTERVAL_MS = 30_000;
const NOTIFICATIONS_QUERY_KEY = ['notifications'];

// Cached per locale — Intl formatter construction is expensive and this runs
// once per notification row per render. Rebuilt only when the language switches.
let relativeFormatter: Intl.RelativeTimeFormat | null = null;
let relativeFormatterLocale = '';

function relativeTimeFormatter(): Intl.RelativeTimeFormat {
  const locale = getFormatLocale();
  if (!relativeFormatter || relativeFormatterLocale !== locale) {
    relativeFormatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeFormatterLocale = locale;
  }
  return relativeFormatter;
}

/** ISO timestamp → short relative label ("5m ago", "in 2h" never occurs — all past). */
function formatRelativeTime(iso: string): string {
  const formatter = relativeTimeFormatter();
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour');
  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, 'day');
}

function NotificationRow({
  notification,
  onRead,
  onNavigate,
}: {
  notification: Notification;
  onRead: () => void;
  onNavigate: () => void;
}) {
  const unread = notification.readAt === null;
  const to = notificationLink(notification);
  const rowClassName = cx(
    'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-neutral-800',
    unread ? 'bg-neutral-800/60' : undefined,
  );
  const inner = (
    <>
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
    </>
  );

  return (
    <li>
      {to ? (
        <Link
          to={to}
          onClick={() => {
            onRead();
            onNavigate();
          }}
          className={rowClassName}
        >
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={onRead} className={rowClassName}>
          {inner}
        </button>
      )}
    </li>
  );
}

/**
 * Notification bell (PROJECTPLAN.md §6.10, §7.4) — unread badge, dropdown list,
 * mark-read/mark-all. V1 freshness is TanStack Query polling + refocus-refetch
 * (no sockets). Shows ACTIVE rows only (#437 — the server's default view, so
 * archived rows never reach the dropdown); the full Active/Archived/All list
 * lives behind the "All notifications" footer link in Settings → Notifications.
 */
export function NotificationBell() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: ({ signal }) => listNotifications({}, signal),
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  // Realtime bell push (§4.5, V3-P7a): a `notification.new` push refreshes the
  // list the moment the row lands. The poll above stays untouched as the
  // fallback — with no gateway (flag off, disconnected) this hook is a no-op.
  useRealtimeEvent(REALTIME_SERVER_EVENTS.notificationNew, () => {
    void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
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
          aria-label={t('settings.notifications.title')}
          className="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
            <span className="text-sm font-medium text-neutral-200">
              {t('settings.notifications.title')}
            </span>
            <button
              type="button"
              onClick={() => markReadMutation.mutate({ all: true })}
              disabled={unreadCount === 0 || markReadMutation.isPending}
              className="text-xs font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              {t('settings.notifications.markAllRead')}
            </button>
          </div>

          {markReadMutation.isError ? (
            <div className="px-3 pt-2">
              <Alert tone="error">{t('settings.notifications.markReadError')}</Alert>
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
              title={t('settings.notifications.loadErrorTitle')}
              description={t('settings.notifications.loadErrorDescription')}
              className="py-10"
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon="🔔"
              title={t('settings.notifications.empty.title')}
              description={t('settings.notifications.empty.description')}
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
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </ul>
          )}

          <div className="border-t border-neutral-800 px-3 py-2 text-center">
            <Link
              to="/settings/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-sky-400 hover:text-sky-300"
            >
              {t('settings.notifications.allTitle')}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
