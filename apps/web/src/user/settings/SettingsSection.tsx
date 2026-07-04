import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet } from 'react-router-dom';

import type {
  MarkReadRequest,
  Notification,
  NotificationSettingsResponse,
} from '@bettertrack/contracts';

import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { getNotificationSettings, updateNotificationSettings } from '../../lib/settingsApi';
import { ComingSoon, EmptyState, Skeleton } from '../../ui';
import { Alert, cx } from '../components/ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

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

export function AccountSettingsPage() {
  return (
    <ComingSoon
      title="Account"
      description="Username and email, change password, base currency (EUR), and portfolio sharing preferences."
    />
  );
}

const NOTIFICATION_SETTINGS_KEY = ['settings', 'notifications'] as const;

/** A minimal on/off switch. Locked (disabled) rows always render as on. */
function Toggle({
  label,
  description,
  checked,
  disabled,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-100">{label}</span>
        <span className="text-xs text-neutral-500">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => onChange?.(!checked)}
        className={cx(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          'disabled:cursor-not-allowed',
          checked ? 'bg-sky-600' : 'bg-neutral-700',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'inline-block h-5 w-5 translate-y-0.5 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
          )}
        />
      </button>
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

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError ? (
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
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800 bg-neutral-900">
            {items.map((notification) => (
              <NotificationListRow
                key={notification.id}
                notification={notification}
                busy={markReadMutation.isPending}
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
 * per-channel toggle panel (in-app locked on, email wired to
 * `GET/PATCH /settings/notifications`) with the full, paged notification list.
 */
export function NotificationSettingsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: NOTIFICATION_SETTINGS_KEY,
    queryFn: ({ signal }) => getNotificationSettings(signal),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (enabled: boolean) => updateNotificationSettings({ email: { enabled } }),
    onSuccess: (data: NotificationSettingsResponse) => {
      queryClient.setQueryData(NOTIFICATION_SETTINGS_KEY, data);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">Notifications</h2>
        <p className="text-sm text-neutral-500">
          Choose how BetterTrack notifies you. In-app notifications are always on.
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
          <Toggle
            label="In-app"
            description="Notifications in the bell menu. Always on."
            checked
            disabled
          />
          <Toggle
            label="Email"
            description="Get an email for friend requests and shared portfolios."
            checked={query.data.email.enabled}
            busy={mutation.isPending}
            onChange={(next) => mutation.mutate(next)}
          />
          {mutation.isError ? (
            <Alert tone="error">Couldn't save that change. Please try again.</Alert>
          ) : null}
        </div>
      )}

      <NotificationList />
    </div>
  );
}

export function SecuritySettingsPage() {
  return (
    <ComingSoon
      title="Security"
      description="Sessions info, PIN enable/change/disable, and the planned two-factor section."
    />
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
