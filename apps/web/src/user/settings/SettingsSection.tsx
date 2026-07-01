import { Outlet } from 'react-router-dom';

import { ComingSoon } from '../../ui';
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

export function NotificationSettingsPage() {
  return (
    <ComingSoon
      title="Notifications"
      description="Per-channel toggles (in-app, email) and the full notification list."
    />
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
