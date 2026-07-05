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

import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { getNotificationSettings, updateNotificationSettings } from '../../lib/settingsApi';
import { ComingSoon, EmptyState, Skeleton } from '../../ui';
import { Alert, cx } from '../components/ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

export { AccountSettingsPage } from './AccountSettingsPage';
export { SecuritySettingsPage } from './SecuritySettingsPage';

/**
 * Settings section shell (PROJECTPLAN.md §6.11, §7.2), reached from the profile
 * menu. Subnav: Account · Notifications · Security, plus the Coming-Soon pages
 * (Imports & Exports · Connections · Backups · API Access). `/settings`
 * redirects to `/settings/account`.
 */
const SETTINGS_SUBNAV: readonly SubNavItem[] = [
  { to: '/settings/account', label: 'Account' },
  { to: '/settings/notifications', label: 'Notifications' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/imports', label: 'Imports & Exports', comingSoon: true },
  { to: '/settings/connections', label: 'Connections', comingSoon: true },
  { to: '/settings/backups', label: 'Backups', comingSoon: true },
  { to: '/settings/api', label: 'API Access', comingSoon: true },
];

export function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Settings</h1>
      <SubNav items={SETTINGS_SUBNAV} />
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
const NOTIFICATION_TYPE_META: Record<NotificationType, { label: string; description: string }> = {
  'friend.request': {
    label: 'Friend requests',
    description: 'When someone sends you a friend request.',
  },
  'friend.accepted': {
    label: 'Accepted friend requests',
    description: 'When someone accepts your friend request.',
  },
  'portfolio.shared': {
    label: 'Shared portfolios',
    description: 'When a friend shares a portfolio with you.',
  },
  'account.invite': {
    label: 'Account invites',
    description: "When you're invited to BetterTrack.",
  },
  'account.temp_password': {
    label: 'Temporary passwords',
    description: 'When an admin issues you a temporary password.',
  },
};

/** The four routing choices a type offers — the two channels collapsed to a mode. */
type RoutingMode = 'both' | 'inapp' | 'email' | 'muted';

const ROUTING_MODE_OPTIONS: readonly { value: RoutingMode; label: string }[] = [
  { value: 'both', label: 'In-app + email' },
  { value: 'inapp', label: 'In-app only' },
  { value: 'email', label: 'Email only' },
  { value: 'muted', label: 'Muted' },
];

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
        {ROUTING_MODE_OPTIONS.map((option) => (
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
        <h3 className="text-sm font-medium text-neutral-300">All notifications</h3>
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
        <Alert tone="error">Couldn't update that notification. Please try again.</Alert>
      ) : null}

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError && items.length === 0 ? (
        <EmptyState
          title="Couldn't load your notifications"
          description="Please try again in a moment."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon="🔔"
          title="No notifications yet"
          description="Activity like friend requests and shares will show up here."
        />
      ) : (
        <>
          {query.isError ? (
            <Alert tone="error">
              Couldn't refresh notifications. Showing the last loaded list.
            </Alert>
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
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">Notifications</h2>
        <p className="text-sm text-neutral-500">
          Choose how BetterTrack notifies you for each kind of activity — the in-app bell, email,
          both, or muted.
        </p>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError ? (
        <EmptyState
          title="Couldn't load your notification settings"
          description="Please try again in a moment."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {NOTIFICATION_TYPES.map((type) => {
            const meta = NOTIFICATION_TYPE_META[type];
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
          {mutation.isError ? (
            <Alert tone="error">Couldn't save that change. Please try again.</Alert>
          ) : null}
        </div>
      )}

      <NotificationList />
    </div>
  );
}

// ─── Coming-Soon pages ────────────────────────────────────────────────────────

export function ImportsExportsPage() {
  return (
    <ComingSoon
      title="Imports & Exports"
      description="Broker CSV imports (Trade Republic, George, …) and full account-data export."
    />
  );
}

export function ConnectionsPage() {
  return (
    <ComingSoon title="Connections" description="Google login and other third-party connections." />
  );
}

export function BackupsPage() {
  return (
    <ComingSoon title="Backups" description="Automatic backups to Google Drive and elsewhere." />
  );
}

export function ApiAccessPage() {
  return (
    <ComingSoon
      title="API Access"
      description="Mint scoped API keys and personal access tokens, and later OAuth apps. See the public API docs at /docs."
    />
  );
}
