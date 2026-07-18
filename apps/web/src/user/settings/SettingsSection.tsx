import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Outlet } from 'react-router-dom';

import {
  NOTIFICATION_CADENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SETTING_CHANNELS,
  NOTIFICATION_TYPES,
  NOTIFICATION_VIEWS,
  type DiscordSettingsResponse,
  type MarkReadRequest,
  type Notification,
  type NotificationCadence,
  type NotificationCategoryKey,
  type NotificationSettingChannel,
  type NotificationSettingsResponse,
  type NotificationType,
  type NotificationTypeRouting,
  type NotificationView,
  type TelegramSettingsResponse,
  type UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import {
  archiveNotification,
  deleteNotification,
  deleteNotifications,
  listNotifications,
  markNotificationsRead,
  unarchiveNotification,
} from '../../lib/notificationsApi';
import {
  confirmTelegramLink,
  getDiscordSettings,
  getNotificationSettings,
  getTelegramSettings,
  removeDiscordWebhook,
  saveDiscordWebhook,
  startTelegramLink,
  testDiscordWebhook,
  unlinkTelegram,
  updateNotificationSettings,
} from '../../lib/settingsApi';
import {
  disableWebPush,
  enableWebPush,
  isWebPushSupported,
  webPushState,
  type WebPushState,
} from '../../lib/webPushClient';
import { ComingSoon, EmptyState, Skeleton } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

export { AccountSettingsPage } from './AccountSettingsPage';
export { ApiAccessPage } from './ApiAccessPage';
export { ConnectionsPage } from './ConnectionsPage';
export { SecuritySettingsPage } from './SecuritySettingsPage';
export { TaxSettingsPage } from './TaxSettingsPage';

/**
 * Settings section shell (PROJECTPLAN.md §6.11, §7.2), reached from the profile
 * menu. Subnav: Account · Notifications · Security · Taxes · Connections · API
 * Access, plus the Coming-Soon pages (Imports & Exports · Backups). `/settings`
 * redirects to `/settings/account`.
 */
export function SettingsLayout() {
  const t = useT();
  const settingsSubnav: readonly SubNavItem[] = [
    { to: '/settings/account', label: t('settings.account.title') },
    { to: '/settings/notifications', label: t('settings.notifications.title') },
    { to: '/settings/security', label: t('settings.security.title') },
    { to: '/settings/taxes', label: t('settings.taxes.title') },
    { to: '/settings/imports', label: t('settings.section.importsExports'), comingSoon: true },
    { to: '/settings/connections', label: t('settings.section.connections') },
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

/** Human labels + descriptions for each routable notification type (§6.10, #368). */
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
    'watchlist.shared': {
      label: t('settings.notifications.types.watchlistShared.label'),
      description: t('settings.notifications.types.watchlistShared.description'),
    },
    'conglomerate.shared': {
      label: t('settings.notifications.types.conglomerateShared.label'),
      description: t('settings.notifications.types.conglomerateShared.description'),
    },
    'friend.activity': {
      label: t('settings.notifications.types.friendActivity.label'),
      description: t('settings.notifications.types.friendActivity.description'),
    },
    'follow.published': {
      label: t('settings.notifications.types.followPublished.label'),
      description: t('settings.notifications.types.followPublished.description'),
    },
    'follow.alert.created': {
      label: t('settings.notifications.types.followAlertCreated.label'),
      description: t('settings.notifications.types.followAlertCreated.description'),
    },
    'follow.alert.fired': {
      label: t('settings.notifications.types.followAlertFired.label'),
      description: t('settings.notifications.types.followAlertFired.description'),
    },
    'account.invite': {
      label: t('settings.notifications.types.accountInvite.label'),
      description: t('settings.notifications.types.accountInvite.description'),
    },
    'account.temp_password': {
      label: t('settings.notifications.types.tempPassword.label'),
      description: t('settings.notifications.types.tempPassword.description'),
    },
    'account.data_export': {
      label: t('settings.notifications.types.dataExport.label'),
      description: t('settings.notifications.types.dataExport.description'),
    },
    'alert.triggered': {
      label: t('settings.notifications.types.alertTriggered.label'),
      description: t('settings.notifications.types.alertTriggered.description'),
    },
    'chat.message': {
      label: t('settings.notifications.types.chatMessage.label'),
      description: t('settings.notifications.types.chatMessage.description'),
    },
    'dividend.event': {
      label: t('settings.notifications.types.dividendEvent.label'),
      description: t('settings.notifications.types.dividendEvent.description'),
    },
  };
}

function channelLabels(t: TranslateFn): Record<NotificationSettingChannel, string> {
  return {
    inapp: t('settings.notifications.channels.inapp'),
    email: t('settings.notifications.channels.email'),
    telegram: t('settings.notifications.channels.telegram'),
    discord: t('settings.notifications.channels.discord'),
    push: t('settings.notifications.channels.push'),
    webpush: t('settings.notifications.channels.webpush'),
  };
}

function categoryLabels(t: TranslateFn): Record<NotificationCategoryKey, string> {
  return {
    social: t('settings.notifications.categories.social'),
    sharing: t('settings.notifications.categories.sharing'),
    chat: t('settings.notifications.categories.chat'),
    alerts: t('settings.notifications.categories.alerts'),
    account: t('settings.notifications.categories.account'),
    market: t('settings.notifications.categories.market'),
  };
}

/**
 * Cells the grid renders but never lets the user toggle (#368):
 *  - `account.invite` routes to people who have no account yet, so per-user
 *    routing cannot apply — the whole row is informational;
 *  - `account.temp_password`'s EMAIL is transactional (it carries the
 *    credential) and always sent directly at the source.
 */
function cellLocked(type: NotificationType, channel: NotificationSettingChannel): boolean {
  if (type === 'account.invite') return true;
  // `account.data_export`'s notice is in-app / push only — no email is sent for
  // it (the download is gated by a token the requester already holds), so its
  // email cell is informational, like `account.temp_password`'s.
  if (type === 'account.data_export' && channel === 'email') return true;
  return type === 'account.temp_password' && channel === 'email';
}

/** The toggle in one (type × channel) grid cell. */
function MatrixCell({
  type,
  channel,
  checked,
  disabled,
  ariaLabel,
  onToggle,
}: {
  type: NotificationType;
  channel: NotificationSettingChannel;
  checked: boolean;
  disabled: boolean;
  ariaLabel: string;
  onToggle: (next: boolean) => void;
}) {
  const locked = cellLocked(type, channel);
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={ariaLabel}
      checked={locked ? channel === 'email' : checked}
      disabled={disabled || locked}
      onChange={(event) => onToggle(event.target.checked)}
      className={cx(
        'h-4 w-4 accent-sky-500',
        (disabled || locked) && 'cursor-not-allowed opacity-50',
      )}
    />
  );
}

/**
 * The redesigned per-type × per-channel grid (#368): rows are types grouped by
 * category, columns are the deployment's LIVE channels as toggles, each
 * category header carries a master toggle, and a global mute sits above.
 */
function NotificationMatrixGrid({
  settings,
  busy,
  onUpdate,
}: {
  settings: NotificationSettingsResponse;
  busy: boolean;
  onUpdate: (patch: UpdateNotificationSettingsRequest) => void;
}) {
  const t = useT();
  const typeMeta = notificationTypeMeta(t);
  const chLabels = channelLabels(t);
  const catLabels = categoryLabels(t);
  // Only columns this deployment can actually deliver (#350/#351 gating).
  const channels = NOTIFICATION_SETTING_CHANNELS.filter((c) => settings.channels[c]);
  const gridDisabled = busy || settings.muted;

  const rowRouting = (type: NotificationType): NotificationTypeRouting => settings.matrix[type];

  function toggleCell(type: NotificationType, channel: NotificationSettingChannel, next: boolean) {
    onUpdate({ matrix: { [type]: { ...rowRouting(type), [channel]: next } } });
  }

  /** Master toggle: any live cell on (ignoring locked ones) counts as "on". */
  function categoryEnabled(types: readonly NotificationType[]): boolean {
    return types.some((type) =>
      channels.some((channel) => !cellLocked(type, channel) && rowRouting(type)[channel]),
    );
  }

  function toggleCategory(types: readonly NotificationType[], next: boolean) {
    const matrix: Partial<Record<NotificationType, NotificationTypeRouting>> = {};
    for (const type of types) {
      if (type === 'account.invite') continue;
      const routing = { ...rowRouting(type) };
      for (const channel of channels) {
        if (!cellLocked(type, channel)) routing[channel] = next;
      }
      matrix[type] = routing;
    }
    if (Object.keys(matrix).length > 0) onUpdate({ matrix });
  }

  return (
    <div
      className={cx(
        'overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900',
        settings.muted && 'opacity-60',
      )}
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="px-4 py-2 text-left font-medium">
              {t('settings.notifications.title')}
            </th>
            {channels.map((channel) => (
              <th scope="col" key={channel} className="px-3 py-2 text-center font-medium">
                {chLabels[channel]}
              </th>
            ))}
          </tr>
        </thead>
        {NOTIFICATION_CATEGORIES.map((category) => (
          <tbody key={category.key} className="border-b border-neutral-800 last:border-b-0">
            <tr className="bg-neutral-950/40">
              <th scope="rowgroup" colSpan={channels.length + 1} className="px-4 py-2 text-left">
                <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={t('settings.notifications.grid.categoryToggleAria', {
                      category: catLabels[category.key],
                    })}
                    checked={categoryEnabled(category.types)}
                    disabled={gridDisabled}
                    onChange={(event) => toggleCategory(category.types, event.target.checked)}
                    className={cx(
                      'h-4 w-4 accent-sky-500',
                      gridDisabled && 'cursor-not-allowed opacity-50',
                    )}
                  />
                  {catLabels[category.key]}
                </label>
              </th>
            </tr>
            {category.types.map((type) => (
              <tr key={type} className="border-t border-neutral-800/60">
                <td className="px-4 py-2.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-neutral-100">{typeMeta[type].label}</span>
                    <span className="text-xs text-neutral-500">
                      {type === 'account.invite'
                        ? t('settings.notifications.grid.inviteHint')
                        : type === 'account.temp_password'
                          ? t('settings.notifications.grid.tempPasswordEmailHint')
                          : typeMeta[type].description}
                    </span>
                  </div>
                </td>
                {channels.map((channel) => (
                  <td key={channel} className="px-3 py-2.5 text-center align-middle">
                    <MatrixCell
                      type={type}
                      channel={channel}
                      checked={rowRouting(type)[channel]}
                      disabled={gridDisabled}
                      ariaLabel={t('settings.notifications.grid.cellAria', {
                        type: typeMeta[type].label,
                        channel: chLabels[channel],
                      })}
                      onToggle={(next) => toggleCell(type, channel, next)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/**
 * Compact per-type digest cadence block (V5-P3). Anti-bloat: NOT another
 * settings wall — a single collapsed `<details>` with a small instant/daily/
 * weekly selector per type. Cadence governs the OUTBOUND channels only; the
 * in-app bell always updates instantly, which the description states.
 */
function NotificationCadenceControls({
  settings,
  busy,
  onUpdate,
}: {
  settings: NotificationSettingsResponse;
  busy: boolean;
  onUpdate: (patch: UpdateNotificationSettingsRequest) => void;
}) {
  const t = useT();
  const typeMeta = notificationTypeMeta(t);
  // account.invite has no per-user routing, so its cadence is meaningless.
  const types = NOTIFICATION_TYPES.filter((type) => type !== 'account.invite');

  return (
    <details className="rounded-md border border-neutral-800 bg-neutral-900">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-neutral-100">
        {t('settings.notifications.digest.title')}
        <p className="mt-0.5 text-xs font-normal text-neutral-500">
          {t('settings.notifications.digest.description')}
        </p>
      </summary>
      <ul className="flex flex-col border-t border-neutral-800">
        {types.map((type) => (
          <li
            key={type}
            className="flex items-center justify-between gap-3 border-b border-neutral-800/60 px-4 py-2.5 last:border-b-0"
          >
            <span className="min-w-0 text-sm text-neutral-200">{typeMeta[type].label}</span>
            <select
              aria-label={t('settings.notifications.digest.selectAria', {
                type: typeMeta[type].label,
              })}
              value={settings.cadence[type]}
              disabled={busy}
              onChange={(event) =>
                onUpdate({ cadence: { [type]: event.target.value as NotificationCadence } })
              }
              className={cx(
                'rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100',
                busy && 'cursor-not-allowed opacity-50',
              )}
            >
              {NOTIFICATION_CADENCES.map((cadence) => (
                <option key={cadence} value={cadence}>
                  {t(`settings.notifications.digest.${cadence}`)}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** HH:MM (24h) ⇄ minutes-since-midnight for the quiet-hours time inputs. */
function timeFromMinutes(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}
function minutesFromTime(value: string): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** The runtime's IANA zone list (+ the current/detected ones), deduped + sorted. */
function timeZoneOptions(current: string | null): string[] {
  const zones = new Set<string>();
  const detected = detectedTimeZone();
  if (detected) zones.add(detected);
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supported === 'function') {
    for (const zone of supported('timeZone')) zones.add(zone);
  }
  if (current) zones.add(current);
  return [...zones].sort();
}

/** The browser's own timezone, for the "use my timezone" shortcut. */
function detectedTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Compact quiet-hours block (§13.5 V5-P3). Anti-bloat: a single collapsed
 * `<details>` alongside the digest block — a switch, and only when enabled the
 * window (start/end) + timezone fold open. Quiet hours defer the OUTBOUND
 * channels only; the in-app bell stays instant, which the description states.
 */
function QuietHoursControls({
  settings,
  busy,
  onUpdate,
}: {
  settings: NotificationSettingsResponse;
  busy: boolean;
  onUpdate: (patch: UpdateNotificationSettingsRequest) => void;
}) {
  const t = useT();
  const quiet = settings.quietHours;
  const zones = useMemo(() => timeZoneOptions(quiet.timezone), [quiet.timezone]);
  const detected = detectedTimeZone();

  return (
    <details className="rounded-md border border-neutral-800 bg-neutral-900">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-neutral-100">
        {t('settings.notifications.quietHours.title')}
        <p className="mt-0.5 text-xs font-normal text-neutral-500">
          {t('settings.notifications.quietHours.description')}
        </p>
      </summary>
      <div className="flex flex-col gap-3 border-t border-neutral-800 px-4 py-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-neutral-200">
            {t('settings.notifications.quietHours.enable')}
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={t('settings.notifications.quietHours.enable')}
            checked={quiet.enabled}
            disabled={busy}
            onChange={(event) => onUpdate({ quietHours: { enabled: event.target.checked } })}
            className={cx('h-4 w-4 accent-sky-500', busy && 'cursor-not-allowed opacity-50')}
          />
        </label>
        {quiet.enabled ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-4">
              <label className="flex flex-col gap-1 text-sm text-neutral-300">
                {t('settings.notifications.quietHours.start')}
                <input
                  type="time"
                  value={timeFromMinutes(quiet.startMinute)}
                  disabled={busy}
                  onChange={(event) => {
                    const minute = minutesFromTime(event.target.value);
                    if (minute !== null) onUpdate({ quietHours: { startMinute: minute } });
                  }}
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-neutral-300">
                {t('settings.notifications.quietHours.end')}
                <input
                  type="time"
                  value={timeFromMinutes(quiet.endMinute)}
                  disabled={busy}
                  onChange={(event) => {
                    const minute = minutesFromTime(event.target.value);
                    if (minute !== null) onUpdate({ quietHours: { endMinute: minute } });
                  }}
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm text-neutral-300">
              {t('settings.notifications.quietHours.timezone')}
              <select
                value={quiet.timezone ?? ''}
                disabled={busy}
                onChange={(event) =>
                  onUpdate({
                    quietHours: { timezone: event.target.value === '' ? null : event.target.value },
                  })
                }
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100"
              >
                <option value="">{t('settings.notifications.quietHours.timezoneNone')}</option>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
            {detected && quiet.timezone !== detected ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onUpdate({ quietHours: { timezone: detected } })}
                className="self-start text-xs font-medium text-sky-400 hover:text-sky-300 disabled:opacity-50"
              >
                {t('settings.notifications.quietHours.useDetected', { zone: detected })}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * Telegram channel setup panel (§13.4 V4-P10). Rendered whenever the deployment
 * has the bot token configured — the initial `available` flag arrives with the
 * settings response and drives whether the whole card renders.
 */
const TELEGRAM_KEY = ['settings', 'telegram'] as const;

function TelegramLinkPanel({ initial }: { initial: TelegramSettingsResponse }) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: TELEGRAM_KEY,
    queryFn: ({ signal }) => getTelegramSettings(signal),
    initialData: initial,
    staleTime: 15_000,
  });
  const settings = query.data ?? initial;

  const startMutation = useMutation({
    mutationFn: () => startTelegramLink(),
    onSuccess: (data) => queryClient.setQueryData(TELEGRAM_KEY, data),
  });
  const confirmMutation = useMutation({
    mutationFn: () => confirmTelegramLink(),
    onSuccess: (result) => queryClient.setQueryData(TELEGRAM_KEY, result.settings),
  });
  const unlinkMutation = useMutation({
    mutationFn: () => unlinkTelegram(),
    onSuccess: (data) => queryClient.setQueryData(TELEGRAM_KEY, data),
  });

  const deepLink =
    settings.botUsername && settings.pendingCode
      ? `https://t.me/${settings.botUsername}?start=${settings.pendingCode}`
      : null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-100">
            {t('settings.notifications.telegram.title')}
          </p>
          <p className="text-xs text-neutral-500">
            {t('settings.notifications.telegram.description')}
          </p>
        </div>
        {settings.linked ? (
          <button
            type="button"
            onClick={() => unlinkMutation.mutate()}
            disabled={unlinkMutation.isPending}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('settings.notifications.telegram.unlink')}
          </button>
        ) : settings.pending && deepLink ? (
          <div className="flex flex-col items-end gap-1">
            <a
              href={deepLink}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-sky-500 px-3 py-1.5 text-sm font-medium text-sky-400 hover:bg-sky-500/10"
            >
              {t('settings.notifications.telegram.openBot')}
            </a>
            <button
              type="button"
              onClick={() => confirmMutation.mutate()}
              disabled={confirmMutation.isPending}
              className="text-xs font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              {confirmMutation.isPending
                ? t('settings.notifications.telegram.confirming')
                : t('settings.notifications.telegram.confirm')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
            className="rounded-md border border-sky-500 px-3 py-1.5 text-sm font-medium text-sky-400 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('settings.notifications.telegram.startLink')}
          </button>
        )}
      </div>
      {settings.linked && settings.chatIdMasked ? (
        <span className="text-xs text-emerald-400">
          {t('settings.notifications.telegram.linked', { id: settings.chatIdMasked })}
        </span>
      ) : null}
      {settings.pending && settings.pendingCode ? (
        <span className="text-xs text-neutral-400">
          {t('settings.notifications.telegram.codeHint', { code: settings.pendingCode })}
        </span>
      ) : null}
      {startMutation.isError ? (
        <Alert tone="error">{t('settings.notifications.telegram.startError')}</Alert>
      ) : null}
      {confirmMutation.isError ||
      (confirmMutation.data && !confirmMutation.data.linked && confirmMutation.isSuccess) ? (
        <Alert tone="error">{t('settings.notifications.telegram.confirmError')}</Alert>
      ) : null}
      {unlinkMutation.isError ? (
        <Alert tone="error">{t('settings.notifications.telegram.unlinkError')}</Alert>
      ) : null}
    </div>
  );
}

/**
 * Discord webhook setup panel (§13.4 V4-P10). No env gate on the server —
 * every user can save a personal webhook.
 */
const DISCORD_KEY = ['settings', 'discord'] as const;

function DiscordWebhookPanel({ initial }: { initial: DiscordSettingsResponse }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [saveErrorKey, setSaveErrorKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<'ok' | 'error' | null>(null);
  const query = useQuery({
    queryKey: DISCORD_KEY,
    queryFn: ({ signal }) => getDiscordSettings(signal),
    initialData: initial,
    staleTime: 15_000,
  });
  const settings = query.data ?? initial;

  const saveMutation = useMutation({
    mutationFn: (raw: string) => saveDiscordWebhook({ url: raw }),
    onSuccess: (data) => {
      queryClient.setQueryData(DISCORD_KEY, data);
      setUrl('');
      setSaveErrorKey(null);
    },
    onError: (err: unknown) => {
      // Map the API error code to an i18n key; fall back to a generic message.
      const code = readErrorCode(err);
      setSaveErrorKey(
        code === 'invalid_webhook'
          ? 'settings.notifications.discord.invalidWebhook'
          : code === 'send_failed'
            ? 'settings.notifications.discord.sendFailed'
            : 'settings.notifications.discord.invalidUrl',
      );
    },
  });
  const testMutation = useMutation({
    mutationFn: () => testDiscordWebhook(),
    onSuccess: () => setTestResult('ok'),
    onError: () => setTestResult('error'),
  });
  const removeMutation = useMutation({
    mutationFn: () => removeDiscordWebhook(),
    onSuccess: (data) => {
      queryClient.setQueryData(DISCORD_KEY, data);
      setTestResult(null);
    },
  });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-neutral-100">
          {t('settings.notifications.discord.title')}
        </p>
        <p className="text-xs text-neutral-500">
          {t('settings.notifications.discord.description')}
        </p>
      </div>
      {settings.linked && settings.webhookIdMasked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-emerald-400">
            {t('settings.notifications.discord.linked', { id: settings.webhookIdMasked })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setTestResult(null);
                testMutation.mutate();
              }}
              disabled={testMutation.isPending}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testMutation.isPending
                ? t('settings.notifications.discord.testing')
                : t('settings.notifications.discord.test')}
            </button>
            <button
              type="button"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('settings.notifications.discord.remove')}
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate(url.trim());
          }}
          className="flex flex-col gap-2"
        >
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            <span>{t('settings.notifications.discord.urlLabel')}</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('settings.notifications.discord.urlPlaceholder')}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none"
              required
            />
          </label>
          <button
            type="submit"
            disabled={saveMutation.isPending || url.trim() === ''}
            className="self-start rounded-md border border-sky-500 px-3 py-1.5 text-sm font-medium text-sky-400 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saveMutation.isPending
              ? t('settings.notifications.discord.saving')
              : t('settings.notifications.discord.save')}
          </button>
        </form>
      )}
      {saveErrorKey ? <Alert tone="error">{t(saveErrorKey)}</Alert> : null}
      {testResult === 'ok' ? (
        <Alert tone="success">{t('settings.notifications.discord.testSuccess')}</Alert>
      ) : null}
      {testResult === 'error' ? (
        <Alert tone="error">{t('settings.notifications.discord.testFailed')}</Alert>
      ) : null}
      {removeMutation.isError ? (
        <Alert tone="error">{t('settings.notifications.discord.removeError')}</Alert>
      ) : null}
    </div>
  );
}

/** Extract the API error code from an `ApiError` thrown by `apiRequest`. */
function readErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : null;
}

/**
 * Card wrapper: fetches the Telegram state and renders the panel when the
 * deployment offers Telegram (V5-P0 kill-switch parent gate + bot token set).
 * When the kill-switch is off the parent skips rendering this entirely, so
 * this component never probes `/settings/telegram` and the setup endpoints
 * stay 404-only.
 */
function TelegramSetupCard() {
  const query = useQuery({
    queryKey: TELEGRAM_KEY,
    queryFn: ({ signal }) => getTelegramSettings(signal),
    staleTime: 15_000,
  });
  if (!query.data || !query.data.available) return null;
  return <TelegramLinkPanel initial={query.data} />;
}

/**
 * Card wrapper: Discord is available server-side whenever the V5-P0 kill-switch
 * is on. Its rendering is gated by the parent on `channelsConfigurable.discord`,
 * so the setup card never probes `/settings/discord` while the flag is off.
 */
function DiscordSetupCard() {
  const query = useQuery({
    queryKey: DISCORD_KEY,
    queryFn: ({ signal }) => getDiscordSettings(signal),
    staleTime: 15_000,
  });
  if (!query.data) return null;
  return <DiscordWebhookPanel initial={query.data} />;
}

/**
 * Per-browser web-push opt-in (#368/#350): rendered only when the deployment
 * has VAPID configured. The permission prompt is triggered exclusively by the
 * enable button here — never on page load.
 */
function WebPushOptIn({ publicKey }: { publicKey: string }) {
  const t = useT();
  const [state, setState] = useState<WebPushState | 'unknown'>('unknown');
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void webPushState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(enable: boolean) {
    setError(false);
    setPending(true);
    try {
      setState(enable ? await enableWebPush(publicKey) : await disableWebPush());
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  const supported = isWebPushSupported();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-neutral-100">
            {t('settings.notifications.webPush.title')}
          </span>
          <span className="text-xs text-neutral-500">
            {t('settings.notifications.webPush.description')}
          </span>
        </div>
        {!supported ? (
          <span className="text-xs text-neutral-500">
            {t('settings.notifications.webPush.unsupported')}
          </span>
        ) : state === 'denied' ? (
          <span className="text-xs text-amber-400">
            {t('settings.notifications.webPush.denied')}
          </span>
        ) : (
          <button
            type="button"
            disabled={pending || state === 'unknown'}
            onClick={() => toggle(state !== 'enabled')}
            className={cx(
              'rounded-md border px-3 py-1.5 text-sm font-medium',
              state === 'enabled'
                ? 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                : 'border-sky-500 text-sky-400 hover:bg-sky-500/10',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {state === 'enabled'
              ? t('settings.notifications.webPush.disable')
              : t('settings.notifications.webPush.enable')}
          </button>
        )}
      </div>
      {state === 'enabled' ? (
        <span className="text-xs text-emerald-400">
          {t('settings.notifications.webPush.enabled')}
        </span>
      ) : null}
      {error ? <Alert tone="error">{t('settings.notifications.webPush.error')}</Alert> : null}
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

/** A per-row archive/unarchive/delete action (#437). */
interface RowAction {
  kind: 'archive' | 'unarchive' | 'delete';
  id: string;
}

function NotificationListRow({
  notification,
  busy,
  onRead,
  onAction,
}: {
  notification: Notification;
  busy: boolean;
  onRead: () => void;
  onAction: (kind: RowAction['kind']) => void;
}) {
  const t = useT();
  const unread = notification.readAt === null;
  const archived = notification.archivedAt !== null;
  const actionClass =
    'rounded px-2 py-1 text-xs font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <li className="flex items-start gap-1 px-2 py-1">
      <button
        type="button"
        onClick={onRead}
        disabled={!unread || busy}
        className={cx(
          'flex min-w-0 flex-1 flex-col gap-0.5 rounded px-2 py-2 text-left transition-colors',
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
      <div className="flex flex-none items-center gap-1 pt-2">
        {archived ? (
          <button
            type="button"
            onClick={() => onAction('unarchive')}
            disabled={busy}
            aria-label={t('settings.notifications.unarchiveAria', { title: notification.title })}
            className={actionClass}
          >
            {t('settings.notifications.unarchive')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onAction('archive')}
            disabled={busy}
            aria-label={t('settings.notifications.archiveAria', { title: notification.title })}
            className={actionClass}
          >
            {t('settings.notifications.archive')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onAction('delete')}
          disabled={busy}
          aria-label={t('settings.notifications.deleteAria', { title: notification.title })}
          className={cx(actionClass, 'text-red-400 hover:bg-red-950/60 hover:text-red-300')}
        >
          {t('common.delete')}
        </button>
      </div>
    </li>
  );
}

/**
 * The destructive bulk-delete confirmations (#437): "all archived" and
 * "absolutely everything", each behind an explicit dialog — no silent wipes.
 */
function BulkDeleteDialog({
  scope,
  busy,
  onConfirm,
  onClose,
}: {
  scope: 'archived' | 'all';
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const base = scope === 'archived' ? 'confirmDeleteArchived' : 'confirmDeleteAll';
  return (
    <Dialog
      title={t(`settings.notifications.${base}.title`)}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <div className="flex flex-col gap-4">
        <Alert tone="error">{t(`settings.notifications.${base}.description`)}</Alert>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="text-red-300 ring-red-900 hover:bg-red-950"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy
              ? t('settings.notifications.deleting')
              : t('settings.notifications.confirmDeleteAction')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The full, paged "All notifications" list (PROJECTPLAN.md §6.10, §6.11; #437)
 * — newest first, cursor-paginated "load more", with an Active | Archived | All
 * view filter, per-item mark-read / archive / unarchive / delete, mark-all, and
 * the two bulk deletions ("all archived", "everything") each behind an explicit
 * destructive confirm dialog. Every mutation invalidates the `notifications`
 * query family so the bell's badge and dropdown
 * (`apps/web/src/user/components/NotificationBell.tsx`) update alongside.
 */
function NotificationList() {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState<NotificationView>('active');
  const [confirmScope, setConfirmScope] = useState<'archived' | 'all' | null>(null);

  const query = useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_LIST_KEY, view],
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      listNotifications({ cursor: pageParam, limit: NOTIFICATIONS_LIST_LIMIT, view }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: NOTIFICATIONS_POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const markReadMutation = useMutation({
    mutationFn: (body: MarkReadRequest) => markNotificationsRead(body),
    onSuccess: () => {
      void invalidate();
    },
  });

  // One mutation for the per-row actions so "busy" and errors stay per-row simple.
  const rowMutation = useMutation({
    mutationFn: (action: RowAction) =>
      action.kind === 'archive'
        ? archiveNotification(action.id)
        : action.kind === 'unarchive'
          ? unarchiveNotification(action.id)
          : deleteNotification(action.id),
    onSuccess: () => {
      void invalidate();
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (scope: 'archived' | 'all') => deleteNotifications(scope),
    onSuccess: () => {
      setConfirmScope(null);
      void invalidate();
    },
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCount = query.data?.pages[0]?.unreadCount ?? 0;
  const rowBusy = (id: string) =>
    isMarkReadPendingFor(markReadMutation, id) ||
    (rowMutation.isPending && rowMutation.variables?.id === id);

  const viewLabels: Record<NotificationView, string> = {
    active: t('settings.notifications.views.active'),
    archived: t('settings.notifications.views.archived'),
    all: t('settings.notifications.views.all'),
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-neutral-300">
          {t('settings.notifications.allTitle')}
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => markReadMutation.mutate({ all: true })}
            disabled={unreadCount === 0 || markReadMutation.isPending}
            className="text-xs font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-neutral-600"
          >
            {t('settings.notifications.markAllRead')}
          </button>
          <button
            type="button"
            onClick={() => setConfirmScope('archived')}
            className="text-xs font-medium text-red-400 hover:text-red-300"
          >
            {t('settings.notifications.deleteArchived')}
          </button>
          <button
            type="button"
            onClick={() => setConfirmScope('all')}
            className="text-xs font-medium text-red-400 hover:text-red-300"
          >
            {t('settings.notifications.deleteAll')}
          </button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label={t('settings.notifications.viewFilterAria')}
        className="flex w-fit items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 p-1"
      >
        {NOTIFICATION_VIEWS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={view === candidate}
            onClick={() => setView(candidate)}
            className={cx(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              view === candidate
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-400 hover:text-neutral-200',
            )}
          >
            {viewLabels[candidate]}
          </button>
        ))}
      </div>

      {markReadMutation.isError ? (
        <Alert tone="error">{t('settings.notifications.markReadError')}</Alert>
      ) : null}
      {rowMutation.isError || bulkDeleteMutation.isError ? (
        <Alert tone="error">{t('settings.notifications.actionError')}</Alert>
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
        view === 'archived' ? (
          <EmptyState icon="🗂️" title={t('settings.notifications.emptyArchived.title')} />
        ) : (
          <EmptyState
            icon="🔔"
            title={t('settings.notifications.empty.title')}
            description={t('settings.notifications.empty.description')}
          />
        )
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
                busy={rowBusy(notification.id)}
                onRead={() => markReadMutation.mutate({ ids: [notification.id] })}
                onAction={(kind) => rowMutation.mutate({ kind, id: notification.id })}
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

      {confirmScope !== null ? (
        <BulkDeleteDialog
          scope={confirmScope}
          busy={bulkDeleteMutation.isPending}
          onConfirm={() => bulkDeleteMutation.mutate(confirmScope)}
          onClose={() => setConfirmScope(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Settings → Notifications page (PROJECTPLAN.md §6.10, §6.11; #368). Composes
 * the global mute, the per-browser web-push opt-in (when the deployment has
 * VAPID), the compact per-type × per-channel grid, and the full, paged
 * notification list — all wired to `GET/PATCH /settings/notifications`.
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
    mutationFn: (patch: UpdateNotificationSettingsRequest) => updateNotificationSettings(patch),
    onSuccess: (data: NotificationSettingsResponse) => {
      queryClient.setQueryData(NOTIFICATION_SETTINGS_KEY, data);
    },
  });

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
          <label className="flex items-start justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-neutral-100">
                {t('settings.notifications.mute.label')}
              </span>
              <span className="text-xs text-neutral-500">
                {t('settings.notifications.mute.description')}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label={t('settings.notifications.mute.label')}
              checked={query.data.muted}
              disabled={mutation.isPending}
              onChange={(event) => mutation.mutate({ muted: event.target.checked })}
              className={cx(
                'mt-0.5 h-4 w-4 accent-sky-500',
                mutation.isPending && 'cursor-not-allowed opacity-50',
              )}
            />
          </label>

          {query.data.channels.webpush && query.data.webPushPublicKey ? (
            <WebPushOptIn publicKey={query.data.webPushPublicKey} />
          ) : null}

          {query.data.channelsConfigurable.telegram ? <TelegramSetupCard /> : null}
          {query.data.channelsConfigurable.discord ? <DiscordSetupCard /> : null}

          <NotificationMatrixGrid
            settings={query.data}
            busy={mutation.isPending}
            onUpdate={(patch) => mutation.mutate(patch)}
          />
          <NotificationCadenceControls
            settings={query.data}
            busy={mutation.isPending}
            onUpdate={(patch) => mutation.mutate(patch)}
          />
          <QuietHoursControls
            settings={query.data}
            busy={mutation.isPending}
            onUpdate={(patch) => mutation.mutate(patch)}
          />
          {mutation.isError ? (
            <Alert tone="error">{t('settings.notifications.grid.saveError')}</Alert>
          ) : null}
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

export function BackupsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('settings.section.backups')}
      description={t('settings.backups.description')}
    />
  );
}
