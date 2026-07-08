import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet } from 'react-router-dom';

import {
  NOTIFICATION_TYPES,
  type MarkReadRequest,
  type Notification,
  type NotificationSettingsResponse,
  type NotificationType,
  type NotificationTypeRouting,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { getNotificationSettings, updateNotificationSettings } from '../../lib/settingsApi';
import { ComingSoon, EmptyState, Skeleton } from '../../ui';
import { Alert, cx } from '../components/ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

export { AccountSettingsPage } from './AccountSettingsPage';
export { ApiAccessPage } from './ApiAccessPage';
export { SecuritySettingsPage } from './SecuritySettingsPage';

/**
 * Settings section shell (PROJECTPLAN.md §6.11, §7.2), reached from the profile
 * menu. Subnav: Account · Notifications · Security, plus the Coming-Soon pages
 * (Imports & Exports · Connections · Backups · API Access). `/settings`
 * redirects to `/settings/account`.
 */
export function SettingsLayout() {
  const t = useT();
  const settingsSubnav: readonly SubNavItem[] = [
    { to: '/settings/account', label: t('settings.account.title') },
    { to: '/settings/notifications', label: t('settings.notifications.title') },
    { to: '/settings/security', label: t('settings.security.title') },
    { to: '/settings/imports', label: t('settings.section.importsExports'), comingSoon: true },
    { to: '/settings/connections', label: t('settings.section.connections'), comingSoon: true },
    { to: '/settings/backups', label: t('settings.section.backups'), comingSoon: true },
    { to: '/settings/api', label: t('settings.api.title') },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
        {t('settings.layout.title')}
      </h1>
      <SubNav items={settingsSubnav} />
      <Outlet />
    </div>
  );
}

// ─── V1 pages (built in the Settings phase) ───────────────────────────────────
//
// Account and Security live in dedicated files (re-exported above); the
// Notifications panel stays here.

const NOTIFICATION_SETTINGS_KEY = ['settings', 'notifications'] as const;

/** Human labels + descriptions for each routable notification type (§6.10). */
function notificationTypeMeta(
  t: TranslateFn,
): Record<NotificationType, { label: string; description: string }> {
  return {
    'friend.request': {
      label: t('settings.notifications.types.friendRequest.label'),
      description: t('settings.notifications.types.friendRequest.description'),
    },
    'friend.accepted': {
      label: t('settings.notifications.types.friendAccepted.label'),
      description: t('settings.notifications.types.friendAccepted.description'),
    },
    'portfolio.shared': {
      label: t('settings.notifications.types.portfolioShared.label'),
      description: t('settings.notifications.types.portfolioShared.description'),
    },
    'account.invite': {
      label: t('settings.notifications.types.accountInvite.label'),
      description: t('settings.notifications.types.accountInvite.description'),
    },
    'account.temp_password': {
      label: t('settings.notifications.types.tempPassword.label'),
      description: t('settings.notifications.types.tempPassword.description'),
    },
    'alert.triggered': {
      label: t('settings.notifications.types.alertTriggered.label'),
      description: t('settings.notifications.types.alertTriggered.description'),
    },
  };
}

/** The four routing choices a type offers — the two channels collapsed to a mode. */
type RoutingMode = 'both' | 'inapp' | 'email' | 'muted';

function routingModeOptions(t: TranslateFn): readonly { value: RoutingMode; label: string }[] {
  return [
    { value: 'both', label: t('settings.notifications.routing.both') },
    { value: 'inapp', label: t('settings.notifications.routing.inapp') },
    { value: 'email', label: t('settings.notifications.routing.email') },
    { value: 'muted', label: t('settings.notifications.routing.muted') },
  ];
}

function routingToMode(routing: NotificationTypeRouting): RoutingMode {
  if (routing.inapp && routing.email) return 'both';
  if (routing.inapp) return 'inapp';
  if (routing.email) return 'email';
  return 'muted';
}

function modeToRouting(mode: RoutingMode): NotificationTypeRouting {
  return { inapp: mode === 'both' || mode === 'inapp', email: mode === 'both' || mode === 'email' };
}

/** One notification type's row in the settings matrix: label + a mode selector. */
function NotificationMatrixRow({
  label,
  description,
  mode,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  mode: RoutingMode;
  busy?: boolean;
  onChange: (next: RoutingMode) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-100">{label}</span>
        <span className="text-xs text-neutral-500">{description}</span>
      </div>
      <select
        aria-label={label}
        value={mode}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as RoutingMode)}
        className={cx(
          'mt-0.5 shrink-0 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {routingModeOptions(t).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const NOTIFICATIONS_LIST_KEY = ['notifications', 'list'] as const;
const NOTIFICATIONS_LIST_LIMIT = 20;
const NOTIFICATIONS_POLL_INTERVAL_MS = 30_000;

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

/** Whether a mark-read mutation currently in flight targets this specific notification. */
function isMarkReadPendingFor(
  mutation: { isPending: boolean; variables: MarkReadRequest | undefined },
  id: string,
): boolean {
  if (!mutation.isPending) return false;
  const vars = mutation.variables;
  return vars !== undefined && 'ids' in vars && vars.ids.includes(id);
}

function NotificationListRow({
  notification,
  busy,
  onRead,
}: {
  notification: Notification;
  busy: boolean;
  onRead: () => void;
}) {
  const unread = notification.readAt === null;
  return (
    <li>
      <button
        type="button"
        onClick={onRead}
        disabled={!unread || busy}
        className={cx(
          'flex w-full flex-col gap-0.5 px-4 py-3 text-left transition-colors',
          unread ? 'bg-neutral-800/60 hover:bg-neutral-800' : 'disabled:cursor-default',
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
        <span className="text-xs text-neutral-500">{notification.body}</span>
        <span className="text-[0.65rem] uppercase tracking-wide text-neutral-600">
          {formatRelativeTime(notification.createdAt)}
        </span>
      </button>
    </li>
  );
}

/**
 * The full, paged notification list (PROJECTPLAN.md §6.10, §6.11) — newest
 * first, cursor-paginated "load more", per-item mark-read and mark-all.
 * Invalidates the `notifications` query family on mark-read so the bell's
 * unread badge (`apps/web/src/user/components/NotificationBell.tsx`) updates
 * alongside this list.
 */
function NotificationList() {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: NOTIFICATIONS_LIST_KEY,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      listNotifications({ cursor: pageParam, limit: NOTIFICATIONS_LIST_LIMIT }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: NOTIFICATIONS_POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const markReadMutation = useMutation({
    mutationFn: (body: MarkReadRequest) => markNotificationsRead(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCount = query.data?.pages[0]?.unreadCount ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-300">
          {t('settings.notifications.allTitle')}
        </h3>
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
        <Alert tone="error">{t('settings.notifications.markReadError')}</Alert>
      ) : null}

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError && items.length === 0 ? (
        <EmptyState
          title={t('settings.notifications.listError.title')}
          description={t('settings.retryHint')}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon="🔔"
          title={t('settings.notifications.empty.title')}
          description={t('settings.notifications.empty.description')}
        />
      ) : (
        <>
          {query.isError ? (
            <Alert tone="error">{t('settings.notifications.refreshError')}</Alert>
          ) : null}
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800 bg-neutral-900">
            {items.map((notification) => (
              <NotificationListRow
                key={notification.id}
                notification={notification}
                busy={isMarkReadPendingFor(markReadMutation, notification.id)}
                onRead={() => markReadMutation.mutate({ ids: [notification.id] })}
              />
            ))}
          </ul>
          {query.hasNextPage ? (
            <button
              type="button"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="self-center text-sm font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              {query.isFetchingNextPage
                ? t('common.loading')
                : t('settings.notifications.loadMore')}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Settings → Notifications page (PROJECTPLAN.md §6.10, §6.11). Composes the
 * per-type × channel routing matrix (each notification type → in-app bell /
 * email / both / muted, wired to `GET/PATCH /settings/notifications`) with the
 * full, paged notification list.
 */
export function NotificationSettingsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: NOTIFICATION_SETTINGS_KEY,
    queryFn: ({ signal }) => getNotificationSettings(signal),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (vars: { type: NotificationType; routing: NotificationTypeRouting }) =>
      updateNotificationSettings({ matrix: { [vars.type]: vars.routing } }),
    onSuccess: (data: NotificationSettingsResponse) => {
      queryClient.setQueryData(NOTIFICATION_SETTINGS_KEY, data);
    },
  });

  const pendingType = mutation.isPending ? mutation.variables?.type : undefined;
  const typeMeta = notificationTypeMeta(t);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">
          {t('settings.notifications.title')}
        </h2>
        <p className="text-sm text-neutral-500">{t('settings.notifications.subtitle')}</p>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError ? (
        <EmptyState
          title={t('settings.notifications.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {NOTIFICATION_TYPES.map((type) => {
            const meta = typeMeta[type];
            return (
              <NotificationMatrixRow
                key={type}
                label={meta.label}
                description={meta.description}
                mode={routingToMode(query.data.matrix[type])}
                busy={pendingType === type}
                onChange={(mode) => mutation.mutate({ type, routing: modeToRouting(mode) })}
              />
            );
          })}
          {mutation.isError ? <Alert tone="error">{t('settings.saveError')}</Alert> : null}
        </div>
      )}

      <NotificationList />
    </div>
  );
}

// ─── Coming-Soon pages ────────────────────────────────────────────────────────

export function ImportsExportsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('settings.section.importsExports')}
      description={t('settings.importsExports.description')}
    />
  );
}

export function ConnectionsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('settings.section.connections')}
      description={t('settings.connections.description')}
    />
  );
}

export function BackupsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('settings.section.backups')}
      description={t('settings.backups.description')}
    />
  );
}
