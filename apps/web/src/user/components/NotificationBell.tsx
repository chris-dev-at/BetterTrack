import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { REALTIME_SERVER_EVENTS } from '@bettertrack/contracts';
import type { MarkReadRequest, Notification } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getFormatLocale } from '../../lib/format';
import { notificationText } from '../../lib/notificationText';
import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { useRealtimeEvent } from '../../lib/realtime';
import { EmptyState, Skeleton } from '../../ui';
import { useOverlayEscape } from '../../ui/overlayStack';
import { restoreFocusTo } from '../../ui/useFocusTrap';
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
      return assetId ? `/assets/${enc(assetId)}` : '/workbench/alerts';
    }
    // Friend request → the requests section of the Friends tab (V4-P0b).
    case 'friend.request':
      return '/people#requests';
    case 'friend.accepted':
      return '/people';
    // Shared items → the recipient's Shared-With-Me view for that item.
    case 'portfolio.shared': {
      const id = payloadString(p, 'portfolioId');
      return id ? `/people/shared/${enc(id)}` : '/people';
    }
    case 'watchlist.shared': {
      const id = payloadString(p, 'watchlistId');
      return id ? `/people/shared/watchlists/${enc(id)}` : '/people';
    }
    case 'conglomerate.shared': {
      const id = payloadString(p, 'conglomerateId');
      return id ? `/people/shared/conglomerates/${enc(id)}` : '/people';
    }
    // Friend activity + newly-published items → the actor's public profile (#438).
    case 'friend.activity':
    case 'follow.published': {
      const username = payloadString(p, 'actorUsername');
      return username ? `/u/${enc(username)}` : '/people';
    }
    // Chat → the DM thread (scroll-to-message is the thread page's concern).
    case 'chat.message': {
      const conversationId = payloadString(p, 'conversationId');
      return conversationId ? `/people/chat/c/${enc(conversationId)}` : '/people/chat';
    }
    // Feedback updates share the compact Control Center surface. The payload's
    // feedbackId/messageId remain available for clients with a detail route.
    case 'feedback.status_changed':
    case 'feedback.reply_created':
      return '/control/feedback';
    // Account/security → the matching settings page.
    case 'account.temp_password':
      return '/settings/security';
    case 'account.invite':
      return '/settings/account';
    // Data export ready (V4-P6a) → the export block in Settings → Account.
    case 'account.data_export':
      return '/settings/account';
    // Standing-order execution problems → the exact row in Forecasts (#1118).
    case 'standing_order.skipped': {
      const id = payloadString(p, 'standingOrderId');
      return id
        ? `/workbench/forecasts#standing-order-${enc(id)}`
        : '/workbench/forecasts#forecast-standing-orders-heading';
    }
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
  const t = useT();
  const unread = notification.readAt === null;
  const to = notificationLink(notification);
  const copy = notificationText(notification, t);
  const rowClassName = cx(
    'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors ',
    unread ? 'bg-[var(--bt-surface-soft)]' : undefined,
  );
  const inner = (
    <>
      <span className="flex items-center gap-2">
        {unread ? (
          <span aria-hidden="true" className="bt-dot bt-dot--gold h-1.5 w-1.5 flex-none" />
        ) : null}
        <span className={cx('truncate text-sm font-medium', unread ? '' : 'bt-muted')}>
          {copy.title}
        </span>
      </span>
      <span className="truncate text-xs bt-muted">{copy.body}</span>
      <span className="text-[0.65rem] uppercase tracking-wide bt-muted">
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
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    restoreFocusTo([triggerRef.current], { exclude: panelRef.current });
  }, []);

  // Non-modal, so it takes Escape through the shared overlay stack like every
  // other popover: it closes only while it is the innermost open overlay, and
  // it closes even when focus never entered the panel.
  useOverlayEscape(open, closeAndRestoreFocus, panelRef);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeAndRestoreFocus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [closeAndRestoreFocus, open]);

  const unreadCount = query.data?.unreadCount ?? 0;
  const items = query.data?.items ?? [];

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? 'bt-notifications-popover' : undefined}
        aria-label={
          unreadCount > 0
            ? t('settings.notifications.bellUnreadAria', { count: unreadCount })
            : t('settings.notifications.bellAria')
        }
        className="relative grid h-9 w-9 place-items-center rounded-full bt-muted transition-colors hover:bt-soft"
        data-testid="notification-bell-trigger"
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
            className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[0.625rem] font-semibold leading-none"
            style={{
              background: 'var(--bt-gold-graphic)',
              color: 'var(--bt-gold-on)',
              boxShadow: '0 0 0 2px var(--bt-bg)',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          aria-label={t('settings.notifications.title')}
          className="bt-popover w-80"
          id="bt-notifications-popover"
          ref={panelRef}
          role="group"
          style={{ right: 0, top: 'calc(100% + 6px)', padding: 0 }}
        >
          <div className="flex items-center justify-between bt-b-rule px-3 py-2">
            <span className="text-sm font-medium bt-soft">{t('settings.notifications.title')}</span>
            <button
              type="button"
              onClick={() => markReadMutation.mutate({ all: true })}
              disabled={unreadCount === 0 || markReadMutation.isPending}
              className="text-xs font-medium bt-link disabled:cursor-not-allowed disabled:bt-muted"
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
            <ul className="max-h-96 bt-band overflow-y-auto">
              {items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onRead={() => {
                    if (notification.readAt === null) {
                      markReadMutation.mutate({ ids: [notification.id] });
                    }
                  }}
                  onNavigate={closeAndRestoreFocus}
                />
              ))}
            </ul>
          )}

          <div className="bt-t-rule px-3 py-2 text-center">
            <Link
              to="/settings/notifications"
              onClick={closeAndRestoreFocus}
              className="text-xs font-medium bt-link"
            >
              {t('settings.notifications.allTitle')}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
