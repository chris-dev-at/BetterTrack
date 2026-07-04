import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet } from 'react-router-dom';

import type { NotificationSettingsResponse } from '@bettertrack/contracts';

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

/**
 * Minimal Settings → Notifications panel (PROJECTPLAN.md §6.10, §6.11). Wires the
 * in-app (locked on) and email toggles to `GET/PATCH /settings/notifications`.
 * The full Settings layout + notification list ships in P7.
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
