import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

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
import { EmptyState, Skeleton } from '../../ui';
import { Badge, Button, Input, SectionHead, Select } from '../../ui/origin';
import { Dialog } from '../components/Dialog';
import { Alert, cx } from '../components/ui';

// ─── Notifications ────────────────────────────────────────────────────────────
//
// The standalone `/settings` shell is retired (R2): every settings surface is a
// Control Center panel now (`../control/ControlCenterOverlay.tsx`), and each
// page component lives in its own file. What remains here is the Notifications
// panel — the matrix, the digest/quiet-hours blocks and the full list.

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
    'earnings.reminder': {
      label: t('settings.notifications.types.earningsReminder.label'),
      description: t('settings.notifications.types.earningsReminder.description'),
    },
    'chat.message': {
      label: t('settings.notifications.types.chatMessage.label'),
      description: t('settings.notifications.types.chatMessage.description'),
    },
    'dividend.event': {
      label: t('settings.notifications.types.dividendEvent.label'),
      description: t('settings.notifications.types.dividendEvent.description'),
    },
    'budget.exceeded': {
      label: t('settings.notifications.types.budgetExceeded.label'),
      description: t('settings.notifications.types.budgetExceeded.description'),
    },
    'mirror.invite': {
      label: t('settings.notifications.types.mirrorInvite.label'),
      description: t('settings.notifications.types.mirrorInvite.description'),
    },
    'mirror.member_joined': {
      label: t('settings.notifications.types.mirrorMemberJoined.label'),
      description: t('settings.notifications.types.mirrorMemberJoined.description'),
    },
    'mirror.member_left': {
      label: t('settings.notifications.types.mirrorMemberLeft.label'),
      description: t('settings.notifications.types.mirrorMemberLeft.description'),
    },
    'mirror.member_removed': {
      label: t('settings.notifications.types.mirrorMemberRemoved.label'),
      description: t('settings.notifications.types.mirrorMemberRemoved.description'),
    },
    'mirror.removed': {
      label: t('settings.notifications.types.mirrorRemoved.label'),
      description: t('settings.notifications.types.mirrorRemoved.description'),
    },
    'mirror.ownership_transferred': {
      label: t('settings.notifications.types.mirrorOwnershipTransferred.label'),
      description: t('settings.notifications.types.mirrorOwnershipTransferred.description'),
    },
    'mirror.chain_dissolved': {
      label: t('settings.notifications.types.mirrorChainDissolved.label'),
      description: t('settings.notifications.types.mirrorChainDissolved.description'),
    },
    'mirror.sync_stalled': {
      label: t('settings.notifications.types.mirrorSyncStalled.label'),
      description: t('settings.notifications.types.mirrorSyncStalled.description'),
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
    budgets: t('settings.notifications.categories.budgets'),
    markets: t('settings.notifications.categories.markets'),
    mirrorchain: t('settings.notifications.categories.mirrorchain'),
    account: t('settings.notifications.categories.account'),
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
  // `budget.exceeded` (V5-P9) is a lightweight in-app / push nudge — the
  // dashboards are the system of record, so no budget email ships; its email
  // cell is informational like the account-notice ones above.
  if (type === 'budget.exceeded' && channel === 'email') return true;
  return type === 'account.temp_password' && channel === 'email';
}

/**
 * The MIRRORCHAIN group-portfolio anti-bloat row (V5-P7 M5, design §11): the
 * eight `mirror.*` notification types collapse to ONE compact row in the
 * matrix. Per-channel switches govern EVERY mirror.* type at once — invites,
 * membership changes, ownership transfers, dissolution, sync-stalled — one
 * decision, one row. The channel cell reads as "on" when EVERY chain type is
 * on for that channel (a mixed state renders as off + a subdued indicator).
 */
function MirrorGroupRow({
  types,
  channels,
  rowRouting,
  gridDisabled,
  onToggleAll,
  t,
  chLabels,
}: {
  types: readonly NotificationType[];
  channels: NotificationSettingChannel[];
  rowRouting: (type: NotificationType) => NotificationTypeRouting;
  gridDisabled: boolean;
  onToggleAll: (channel: NotificationSettingChannel, next: boolean) => void;
  t: TranslateFn;
  chLabels: Record<NotificationSettingChannel, string>;
}) {
  const summary = (channel: NotificationSettingChannel): 'on' | 'off' | 'mixed' => {
    const flags = types.map((type) => rowRouting(type)[channel]);
    if (flags.every(Boolean)) return 'on';
    if (flags.every((v) => !v)) return 'off';
    return 'mixed';
  };
  return (
    <tr>
      <td>
        <div className="flex flex-col gap-0.5">
          <span className="bt-row-title">{t('settings.notifications.mirrorchain.groupLabel')}</span>
          <span className="bt-row-sub">{t('settings.notifications.mirrorchain.groupHint')}</span>
        </div>
      </td>
      {channels.map((channel) => {
        const state = summary(channel);
        return (
          <td key={channel} className="text-center align-middle">
            {/* Origin switch look, unchanged semantics: the real input keeps
                role/aria-checked (incl. the tri-state "mixed") and its label. */}
            <label
              className={cx(
                'relative inline-flex shrink-0 cursor-pointer items-center',
                gridDisabled && 'cursor-not-allowed',
              )}
              style={{
                width: 34,
                height: 20,
                borderRadius: 999,
                border: `1px solid ${state === 'on' ? 'var(--bt-gold)' : 'var(--bt-border-strong)'}`,
                background: state === 'on' ? 'var(--bt-gold)' : 'var(--bt-surface-soft)',
                opacity: gridDisabled ? 0.5 : undefined,
                transition: 'background var(--bt-t-fast), border-color var(--bt-t-fast)',
              }}
            >
              <input
                type="checkbox"
                role="switch"
                checked={state === 'on'}
                aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
                aria-label={t('settings.notifications.mirrorchain.cellAria', {
                  channel: chLabels[channel],
                })}
                disabled={gridDisabled}
                onChange={(event) => onToggleAll(channel, event.target.checked)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className="inline-block"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  marginLeft: 2,
                  transform: state === 'on' ? 'translateX(14px)' : undefined,
                  background:
                    state === 'on'
                      ? 'var(--bt-gold-ink)'
                      : state === 'mixed'
                        ? 'var(--bt-gold)'
                        : 'var(--bt-muted)',
                  transition: 'transform var(--bt-t-fast), background var(--bt-t-fast)',
                }}
              />
            </label>
          </td>
        );
      })}
    </tr>
  );
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
      className={cx('h-4 w-4', (disabled || locked) && 'cursor-not-allowed')}
      style={{ accentColor: 'var(--bt-gold)', opacity: disabled || locked ? 0.5 : undefined }}
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
      className="bt-table-wrap bt-table-wrap--panel"
      style={{ opacity: settings.muted ? 0.6 : undefined }}
    >
      <table className="bt-table">
        <thead>
          <tr>
            <th scope="col">{t('settings.notifications.title')}</th>
            {channels.map((channel) => (
              <th scope="col" key={channel} style={{ textAlign: 'center' }}>
                {chLabels[channel]}
              </th>
            ))}
          </tr>
        </thead>
        {NOTIFICATION_CATEGORIES.map((category) => {
          // MIRRORCHAIN group portfolios (V5-P7 M5, design §11): the eight
          // chain notices join the matrix as ONE compact group row
          // (anti-bloat) — the visible row governs every mirror.* type as
          // one, all-or-nothing per channel.
          const isMirrorchain = category.key === 'mirrorchain';
          return (
            <tbody key={category.key}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={channels.length + 1}
                  style={{ position: 'static', background: 'var(--bt-surface-soft)' }}
                >
                  <label className="bt-label flex items-center gap-2">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t('settings.notifications.grid.categoryToggleAria', {
                        category: catLabels[category.key],
                      })}
                      checked={categoryEnabled(category.types)}
                      disabled={gridDisabled}
                      onChange={(event) => toggleCategory(category.types, event.target.checked)}
                      className={cx('h-4 w-4', gridDisabled && 'cursor-not-allowed')}
                      style={{
                        accentColor: 'var(--bt-gold)',
                        opacity: gridDisabled ? 0.5 : undefined,
                      }}
                    />
                    {catLabels[category.key]}
                  </label>
                </th>
              </tr>
              {isMirrorchain ? (
                <MirrorGroupRow
                  types={category.types}
                  channels={channels}
                  rowRouting={rowRouting}
                  gridDisabled={gridDisabled}
                  onToggleAll={(channel, next) => {
                    const matrix: Partial<Record<NotificationType, NotificationTypeRouting>> = {};
                    for (const type of category.types) {
                      matrix[type] = { ...rowRouting(type), [channel]: next };
                    }
                    onUpdate({ matrix });
                  }}
                  t={t}
                  chLabels={chLabels}
                />
              ) : (
                category.types.map((type) => (
                  <tr key={type}>
                    <td>
                      <div className="flex flex-col gap-0.5">
                        <span className="bt-row-title">{typeMeta[type].label}</span>
                        <span className="bt-row-sub">
                          {type === 'account.invite'
                            ? t('settings.notifications.grid.inviteHint')
                            : type === 'account.temp_password'
                              ? t('settings.notifications.grid.tempPasswordEmailHint')
                              : typeMeta[type].description}
                        </span>
                      </div>
                    </td>
                    {channels.map((channel) => (
                      <td key={channel} className="text-center align-middle">
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
                ))
              )}
            </tbody>
          );
        })}
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
    <details className="bt-panel">
      <summary className="bt-h3 cursor-pointer" style={{ padding: '13px 20px' }}>
        {t('settings.notifications.digest.title')}
        <p className="bt-meta" style={{ marginTop: 2, fontWeight: 400 }}>
          {t('settings.notifications.digest.description')}
        </p>
      </summary>
      <ul className="bt-band bt-t-rule flex flex-col">
        {types.map((type) => (
          <li
            key={type}
            className="bt-band__row flex items-center justify-between gap-3"
            style={{ paddingBlock: 10 }}
          >
            <span className="bt-soft min-w-0">{typeMeta[type].label}</span>
            <Select
              aria-label={t('settings.notifications.digest.selectAria', {
                type: typeMeta[type].label,
              })}
              value={settings.cadence[type]}
              disabled={busy}
              onChange={(event) =>
                onUpdate({ cadence: { [type]: event.target.value as NotificationCadence } })
              }
              className={cx(busy && 'cursor-not-allowed')}
              style={{ width: 'auto', minHeight: 28, opacity: busy ? 0.5 : undefined }}
            >
              {NOTIFICATION_CADENCES.map((cadence) => (
                <option key={cadence} value={cadence}>
                  {t(`settings.notifications.digest.${cadence}`)}
                </option>
              ))}
            </Select>
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
    <details className="bt-panel">
      <summary className="bt-h3 cursor-pointer" style={{ padding: '13px 20px' }}>
        {t('settings.notifications.quietHours.title')}
        <p className="bt-meta" style={{ marginTop: 2, fontWeight: 400 }}>
          {t('settings.notifications.quietHours.description')}
        </p>
      </summary>
      <div className="bt-t-rule flex flex-col gap-3" style={{ padding: '13px 20px' }}>
        <label className="flex items-center justify-between gap-3">
          <span className="bt-soft">{t('settings.notifications.quietHours.enable')}</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={t('settings.notifications.quietHours.enable')}
            checked={quiet.enabled}
            disabled={busy}
            onChange={(event) => onUpdate({ quietHours: { enabled: event.target.checked } })}
            className={cx('h-4 w-4', busy && 'cursor-not-allowed')}
            style={{ accentColor: 'var(--bt-gold)', opacity: busy ? 0.5 : undefined }}
          />
        </label>
        {quiet.enabled ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-4">
              <label className="bt-field bt-soft" style={{ fontSize: 12, fontWeight: 570 }}>
                {t('settings.notifications.quietHours.start')}
                <Input
                  type="time"
                  value={timeFromMinutes(quiet.startMinute)}
                  disabled={busy}
                  onChange={(event) => {
                    const minute = minutesFromTime(event.target.value);
                    if (minute !== null) onUpdate({ quietHours: { startMinute: minute } });
                  }}
                  style={{ width: 'auto' }}
                />
              </label>
              <label className="bt-field bt-soft" style={{ fontSize: 12, fontWeight: 570 }}>
                {t('settings.notifications.quietHours.end')}
                <Input
                  type="time"
                  value={timeFromMinutes(quiet.endMinute)}
                  disabled={busy}
                  onChange={(event) => {
                    const minute = minutesFromTime(event.target.value);
                    if (minute !== null) onUpdate({ quietHours: { endMinute: minute } });
                  }}
                  style={{ width: 'auto' }}
                />
              </label>
            </div>
            <label className="bt-field bt-soft max-w-sm" style={{ fontSize: 12, fontWeight: 570 }}>
              {t('settings.notifications.quietHours.timezone')}
              <Select
                value={quiet.timezone ?? ''}
                disabled={busy}
                onChange={(event) =>
                  onUpdate({
                    quietHours: { timezone: event.target.value === '' ? null : event.target.value },
                  })
                }
              >
                <option value="">{t('settings.notifications.quietHours.timezoneNone')}</option>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </label>
            {detected && quiet.timezone !== detected ? (
              <Button
                type="button"
                size="sm"
                variant="quiet"
                className="self-start"
                disabled={busy}
                onClick={() => onUpdate({ quietHours: { timezone: detected } })}
              >
                {t('settings.notifications.quietHours.useDetected', { zone: detected })}
              </Button>
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
    <div className="bt-panel flex flex-col gap-2" style={{ padding: '13px 16px' }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="bt-row-title">{t('settings.notifications.telegram.title')}</p>
          <p className="bt-row-sub">{t('settings.notifications.telegram.description')}</p>
        </div>
        {settings.linked ? (
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => unlinkMutation.mutate()}
            disabled={unlinkMutation.isPending}
          >
            {t('settings.notifications.telegram.unlink')}
          </Button>
        ) : settings.pending && deepLink ? (
          <div className="flex flex-col items-end gap-1">
            <a className="bt-btn bt-btn--sm" href={deepLink} target="_blank" rel="noreferrer">
              {t('settings.notifications.telegram.openBot')}
            </a>
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => confirmMutation.mutate()}
              disabled={confirmMutation.isPending}
            >
              {confirmMutation.isPending
                ? t('settings.notifications.telegram.confirming')
                : t('settings.notifications.telegram.confirm')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
          >
            {t('settings.notifications.telegram.startLink')}
          </Button>
        )}
      </div>
      {settings.linked && settings.chatIdMasked ? (
        <span className="bt-pos" style={{ fontSize: 12 }}>
          {t('settings.notifications.telegram.linked', { id: settings.chatIdMasked })}
        </span>
      ) : null}
      {settings.pending && settings.pendingCode ? (
        <span className="bt-row-sub">
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
    <div className="bt-panel flex flex-col gap-2" style={{ padding: '13px 16px' }}>
      <div className="flex flex-col gap-1">
        <p className="bt-row-title">{t('settings.notifications.discord.title')}</p>
        <p className="bt-row-sub">{t('settings.notifications.discord.description')}</p>
      </div>
      {settings.linked && settings.webhookIdMasked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="bt-pos" style={{ fontSize: 12 }}>
            {t('settings.notifications.discord.linked', { id: settings.webhookIdMasked })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setTestResult(null);
                testMutation.mutate();
              }}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending
                ? t('settings.notifications.discord.testing')
                : t('settings.notifications.discord.test')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
            >
              {t('settings.notifications.discord.remove')}
            </Button>
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
          <label className="bt-field max-w-xl">
            <span className="bt-label">{t('settings.notifications.discord.urlLabel')}</span>
            <Input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('settings.notifications.discord.urlPlaceholder')}
              required
            />
          </label>
          <Button
            type="submit"
            size="sm"
            className="self-start"
            disabled={saveMutation.isPending || url.trim() === ''}
          >
            {saveMutation.isPending
              ? t('settings.notifications.discord.saving')
              : t('settings.notifications.discord.save')}
          </Button>
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
    <div className="bt-panel flex flex-col gap-2" style={{ padding: '13px 16px' }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="bt-row-title">{t('settings.notifications.webPush.title')}</span>
          <span className="bt-row-sub">{t('settings.notifications.webPush.description')}</span>
        </div>
        {!supported ? (
          <span className="bt-meta">{t('settings.notifications.webPush.unsupported')}</span>
        ) : state === 'denied' ? (
          <Badge tone="gold">{t('settings.notifications.webPush.denied')}</Badge>
        ) : (
          <Button
            type="button"
            size="sm"
            variant={state === 'enabled' ? 'danger' : 'neutral'}
            disabled={pending || state === 'unknown'}
            onClick={() => toggle(state !== 'enabled')}
          >
            {state === 'enabled'
              ? t('settings.notifications.webPush.disable')
              : t('settings.notifications.webPush.enable')}
          </Button>
        )}
      </div>
      {state === 'enabled' ? (
        <span className="bt-pos" style={{ fontSize: 12 }}>
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
  return (
    <li className="bt-band__row flex items-start gap-1" style={{ paddingBlock: 4 }}>
      <button
        type="button"
        onClick={onRead}
        disabled={!unread || busy}
        className={cx(
          'flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-2 text-left',
          !unread && 'disabled:cursor-default',
        )}
        style={{
          border: 0,
          borderRadius: 6,
          background: unread ? 'var(--bt-gold-soft)' : 'none',
          color: 'inherit',
          font: 'inherit',
          cursor: unread && !busy ? 'pointer' : undefined,
          transition: 'background var(--bt-t-fast)',
        }}
      >
        <span className="flex items-center gap-2">
          {unread ? (
            <span
              aria-hidden="true"
              className="bt-dot bt-dot--gold"
              style={{ width: 6, height: 6 }}
            />
          ) : null}
          <span className={cx('truncate', unread ? 'bt-row-title' : 'bt-muted')}>
            {notification.title}
          </span>
        </span>
        <span className="bt-row-sub">{notification.body}</span>
        <span className="bt-label" style={{ fontSize: 10.5 }}>
          {formatRelativeTime(notification.createdAt)}
        </span>
      </button>
      <div className="flex flex-none items-center gap-1 pt-2">
        {archived ? (
          <Button
            type="button"
            size="sm"
            variant="quiet"
            onClick={() => onAction('unarchive')}
            disabled={busy}
            aria-label={t('settings.notifications.unarchiveAria', { title: notification.title })}
          >
            {t('settings.notifications.unarchive')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="quiet"
            onClick={() => onAction('archive')}
            disabled={busy}
            aria-label={t('settings.notifications.archiveAria', { title: notification.title })}
          >
            {t('settings.notifications.archive')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="danger"
          onClick={() => onAction('delete')}
          disabled={busy}
          aria-label={t('settings.notifications.deleteAria', { title: notification.title })}
        >
          {t('common.delete')}
        </Button>
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
          <Button type="button" variant="quiet" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={busy}>
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
        <h3 className="bt-h3">{t('settings.notifications.allTitle')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="quiet"
            onClick={() => markReadMutation.mutate({ all: true })}
            disabled={unreadCount === 0 || markReadMutation.isPending}
          >
            {t('settings.notifications.markAllRead')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => setConfirmScope('archived')}
          >
            {t('settings.notifications.deleteArchived')}
          </Button>
          <Button type="button" size="sm" variant="danger" onClick={() => setConfirmScope('all')}>
            {t('settings.notifications.deleteAll')}
          </Button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label={t('settings.notifications.viewFilterAria')}
        className="bt-seg w-fit"
      >
        {NOTIFICATION_VIEWS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={view === candidate}
            onClick={() => setView(candidate)}
            className={cx(view === candidate && 'is-active')}
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
          <ul className="bt-panel bt-band">
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
            <Button
              type="button"
              variant="quiet"
              className="self-center"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage
                ? t('common.loading')
                : t('settings.notifications.loadMore')}
            </Button>
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
      <SectionHead
        sub={t('settings.notifications.subtitle')}
        title={t('settings.notifications.title')}
      />

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
          <label
            className="bt-panel flex items-start justify-between gap-4"
            style={{ padding: '13px 16px' }}
          >
            <span className="flex flex-col gap-0.5">
              <span className="bt-row-title">{t('settings.notifications.mute.label')}</span>
              <span className="bt-row-sub">{t('settings.notifications.mute.description')}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label={t('settings.notifications.mute.label')}
              checked={query.data.muted}
              disabled={mutation.isPending}
              onChange={(event) => mutation.mutate({ muted: event.target.checked })}
              className={cx('mt-0.5 h-4 w-4', mutation.isPending && 'cursor-not-allowed')}
              style={{
                accentColor: 'var(--bt-gold)',
                opacity: mutation.isPending ? 0.5 : undefined,
              }}
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
