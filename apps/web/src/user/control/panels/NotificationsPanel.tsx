import { useEffect, useMemo, useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  NOTIFICATION_CADENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SETTING_CHANNELS,
  NOTIFICATION_TYPES,
  type DiscordSettingsResponse,
  type NotificationCadence,
  type NotificationCategoryKey,
  type NotificationSettingChannel,
  type NotificationSettingsResponse,
  type NotificationType,
  type NotificationTypeRouting,
  type TelegramSettingsResponse,
  type UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { cx } from '../../../lib/cx';
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
} from '../../../lib/settingsApi';
import {
  disableWebPush,
  enableWebPush,
  isWebPushSupported,
  webPushState,
  type WebPushState,
} from '../../../lib/webPushClient';
import { EmptyState, Skeleton } from '../../../ui';
import { Badge, Button, Field, Input, Select } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { PanelFold, PanelForm, PanelGroup, PanelHead, PanelNote, Row } from './panelKit';

/**
 * Control Center → Notifications (PROJECTPLAN.md §6.10, §6.11; #368) rebuilt for
 * the popup (R2). DELIVERY PREFERENCES only — the inbox itself is its own panel
 * (`NotificationLogPanel`). Same queries, same PATCH payloads, same aria: what
 * changed is the shape. The page's cards, its title stack and the paragraph
 * under every control are gone; what survives is four groups of ruled rows and
 * the two disclosures, with prose kept only where it states a real constraint
 * (muting keeps your choices, why a matrix cell is locked, cadence/quiet hours
 * govern outbound channels only).
 */

const NOTIFICATION_SETTINGS_KEY = ['settings', 'notifications'] as const;
const TELEGRAM_KEY = ['settings', 'telegram'] as const;
const DISCORD_KEY = ['settings', 'discord'] as const;

/**
 * Human label for each routable notification type (§6.10, #368). The popup rows
 * carry the label alone — the per-type prose the page printed under every row
 * doubled the height of a 25-row table without telling the user anything the
 * label and the group heading do not.
 */
function notificationTypeLabels(t: TranslateFn): Record<NotificationType, string> {
  return {
    'friend.request': t('settings.notifications.types.friendRequest.label'),
    'friend.accepted': t('settings.notifications.types.friendAccepted.label'),
    'portfolio.shared': t('settings.notifications.types.portfolioShared.label'),
    'watchlist.shared': t('settings.notifications.types.watchlistShared.label'),
    'conglomerate.shared': t('settings.notifications.types.conglomerateShared.label'),
    'friend.activity': t('settings.notifications.types.friendActivity.label'),
    'follow.published': t('settings.notifications.types.followPublished.label'),
    'follow.alert.created': t('settings.notifications.types.followAlertCreated.label'),
    'follow.alert.fired': t('settings.notifications.types.followAlertFired.label'),
    'account.invite': t('settings.notifications.types.accountInvite.label'),
    'account.temp_password': t('settings.notifications.types.tempPassword.label'),
    'account.data_export': t('settings.notifications.types.dataExport.label'),
    'alert.triggered': t('settings.notifications.types.alertTriggered.label'),
    'earnings.reminder': t('settings.notifications.types.earningsReminder.label'),
    'chat.message': t('settings.notifications.types.chatMessage.label'),
    'dividend.event': t('settings.notifications.types.dividendEvent.label'),
    'budget.exceeded': t('settings.notifications.types.budgetExceeded.label'),
    'mirror.invite': t('settings.notifications.types.mirrorInvite.label'),
    'mirror.member_joined': t('settings.notifications.types.mirrorMemberJoined.label'),
    'mirror.member_left': t('settings.notifications.types.mirrorMemberLeft.label'),
    'mirror.member_removed': t('settings.notifications.types.mirrorMemberRemoved.label'),
    'mirror.removed': t('settings.notifications.types.mirrorRemoved.label'),
    'mirror.ownership_transferred': t(
      'settings.notifications.types.mirrorOwnershipTransferred.label',
    ),
    'mirror.chain_dissolved': t('settings.notifications.types.mirrorChainDissolved.label'),
    'mirror.sync_stalled': t('settings.notifications.types.mirrorSyncStalled.label'),
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

/** The one constraint a matrix row is allowed to spend a second line on: why it is locked. */
function lockedRowNote(t: TranslateFn, type: NotificationType): string | null {
  if (type === 'account.invite') return t('settings.notifications.grid.inviteHint');
  if (type === 'account.temp_password')
    return t('settings.notifications.grid.tempPasswordEmailHint');
  return null;
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
            {/* THE SAME CONTROL AS EVERY CELL BELOW IT (owner, 2026-07-31).
                This used to be a bespoke sliding pill while every per-type cell
                in the same table was a checkbox — two vocabularies for one
                question, with nothing to tell a reader why. It is a master over
                a column, which is a real difference, but that is what
                `indeterminate` is FOR: "some of the things under me are on".
                The tri-state is preserved exactly; only the shape changed. */}
            <input
              aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
              aria-label={t('settings.notifications.mirrorchain.cellAria', {
                channel: chLabels[channel],
              })}
              checked={state === 'on'}
              className={cx('h-4 w-4', gridDisabled && 'cursor-not-allowed')}
              disabled={gridDisabled}
              onChange={(event) => onToggleAll(channel, event.target.checked)}
              ref={(node) => {
                // Only the DOM property can express "mixed" — there is no
                // attribute for it, so React cannot set it declaratively.
                if (node) node.indeterminate = state === 'mixed';
              }}
              role="switch"
              style={{ accentColor: 'var(--bt-gold)', opacity: gridDisabled ? 0.5 : undefined }}
              type="checkbox"
            />
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
 * The per-type × per-channel grid (#368): rows are types grouped by category,
 * columns are the deployment's LIVE channels as toggles, each category header
 * carries a master toggle. It stays a real table — the one place in the popup
 * where a grid IS the control.
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
  const typeLabels = notificationTypeLabels(t);
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
                category.types.map((type) => {
                  const note = lockedRowNote(t, type);
                  return (
                    <tr key={type}>
                      <td>
                        {note ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="bt-row-title">{typeLabels[type]}</span>
                            <span className="bt-row-sub">{note}</span>
                          </div>
                        ) : (
                          <span className="bt-row-title">{typeLabels[type]}</span>
                        )}
                      </td>
                      {channels.map((channel) => (
                        <td key={channel} className="text-center align-middle">
                          <MatrixCell
                            type={type}
                            channel={channel}
                            checked={rowRouting(type)[channel]}
                            disabled={gridDisabled}
                            ariaLabel={t('settings.notifications.grid.cellAria', {
                              type: typeLabels[type],
                              channel: chLabels[channel],
                            })}
                            onToggle={(next) => toggleCell(type, channel, next)}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/**
 * Per-type digest cadence (V5-P3), folded away: a `<details>` with one small
 * instant/daily/weekly row per type. Cadence governs the OUTBOUND channels
 * only — the in-app bell always updates instantly, which is the one line of
 * prose this block keeps.
 */
function CadenceFold({
  settings,
  busy,
  onUpdate,
}: {
  settings: NotificationSettingsResponse;
  busy: boolean;
  onUpdate: (patch: UpdateNotificationSettingsRequest) => void;
}) {
  const t = useT();
  const typeLabels = notificationTypeLabels(t);
  // account.invite has no per-user routing, so its cadence is meaningless.
  const types = NOTIFICATION_TYPES.filter((type) => type !== 'account.invite');

  return (
    <PanelFold summary={t('settings.notifications.digest.title')}>
      <div className="flex flex-col gap-2">
        <PanelNote>{t('settings.notifications.digest.description')}</PanelNote>
        <PanelGroup>
          {types.map((type) => (
            <Row key={type} label={typeLabels[type]}>
              <Select
                aria-label={t('settings.notifications.digest.selectAria', {
                  type: typeLabels[type],
                })}
                value={settings.cadence[type]}
                disabled={busy}
                onChange={(event) =>
                  onUpdate({ cadence: { [type]: event.target.value as NotificationCadence } })
                }
                className={cx(busy && 'cursor-not-allowed')}
                style={{ width: 'auto', opacity: busy ? 0.5 : undefined }}
              >
                {NOTIFICATION_CADENCES.map((cadence) => (
                  <option key={cadence} value={cadence}>
                    {t(`settings.notifications.digest.${cadence}`)}
                  </option>
                ))}
              </Select>
            </Row>
          ))}
        </PanelGroup>
      </div>
    </PanelFold>
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
 * Quiet hours (§13.5 V5-P3), folded away beside the cadence block: a switch,
 * and only when enabled the window (start/end) + timezone rows. Quiet hours
 * defer the OUTBOUND channels only — urgent account notices and the in-app bell
 * still get through, which is why that line stays.
 */
function QuietHoursFold({
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
    <PanelFold summary={t('settings.notifications.quietHours.title')}>
      <div className="flex flex-col gap-2">
        <PanelNote>{t('settings.notifications.quietHours.description')}</PanelNote>
        <PanelGroup>
          <Row label={t('settings.notifications.quietHours.enable')}>
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
          </Row>
          {quiet.enabled ? (
            <>
              <Row htmlFor="quietHoursStart" label={t('settings.notifications.quietHours.start')}>
                <Input
                  id="quietHoursStart"
                  type="time"
                  value={timeFromMinutes(quiet.startMinute)}
                  disabled={busy}
                  onChange={(event) => {
                    const minute = minutesFromTime(event.target.value);
                    if (minute !== null) onUpdate({ quietHours: { startMinute: minute } });
                  }}
                  style={{ width: 'auto' }}
                />
              </Row>
              <Row htmlFor="quietHoursEnd" label={t('settings.notifications.quietHours.end')}>
                <Input
                  id="quietHoursEnd"
                  type="time"
                  value={timeFromMinutes(quiet.endMinute)}
                  disabled={busy}
                  onChange={(event) => {
                    const minute = minutesFromTime(event.target.value);
                    if (minute !== null) onUpdate({ quietHours: { endMinute: minute } });
                  }}
                  style={{ width: 'auto' }}
                />
              </Row>
              <Row
                htmlFor="quietHoursTimezone"
                label={t('settings.notifications.quietHours.timezone')}
              >
                <Select
                  id="quietHoursTimezone"
                  value={quiet.timezone ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    onUpdate({
                      quietHours: {
                        timezone: event.target.value === '' ? null : event.target.value,
                      },
                    })
                  }
                  style={{ width: 'auto', maxWidth: 220 }}
                >
                  <option value="">{t('settings.notifications.quietHours.timezoneNone')}</option>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              </Row>
              {detected && quiet.timezone !== detected ? (
                <Row>
                  <Button
                    type="button"
                    size="sm"
                    variant="quiet"
                    disabled={busy}
                    onClick={() => onUpdate({ quietHours: { timezone: detected } })}
                  >
                    {t('settings.notifications.quietHours.useDetected', { zone: detected })}
                  </Button>
                </Row>
              ) : null}
            </>
          ) : null}
        </PanelGroup>
      </div>
    </PanelFold>
  );
}

/**
 * Telegram channel setup (§13.4 V4-P10) as ONE row: state on the left, the
 * handshake's single next step on the right. Rendered whenever the deployment
 * has the bot token configured.
 */
function TelegramRows({ initial }: { initial: TelegramSettingsResponse }) {
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
    <>
      <Row label={t('settings.notifications.telegram.title')}>
        {settings.linked && settings.chatIdMasked ? (
          <span className="bt-pos" style={{ fontSize: 12 }}>
            {t('settings.notifications.telegram.linked', { id: settings.chatIdMasked })}
          </span>
        ) : null}
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
          <>
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
          </>
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
      </Row>
      {settings.pending && settings.pendingCode ? (
        <Row>
          <PanelNote>
            {t('settings.notifications.telegram.codeHint', { code: settings.pendingCode })}
          </PanelNote>
        </Row>
      ) : null}
      {startMutation.isError ? (
        <Row>
          <Alert tone="error">{t('settings.notifications.telegram.startError')}</Alert>
        </Row>
      ) : null}
      {confirmMutation.isError ||
      (confirmMutation.data && !confirmMutation.data.linked && confirmMutation.isSuccess) ? (
        <Row>
          <Alert tone="error">{t('settings.notifications.telegram.confirmError')}</Alert>
        </Row>
      ) : null}
      {unlinkMutation.isError ? (
        <Row>
          <Alert tone="error">{t('settings.notifications.telegram.unlinkError')}</Alert>
        </Row>
      ) : null}
    </>
  );
}

/**
 * Discord webhook setup (§13.4 V4-P10). No env gate on the server — every user
 * can save a personal webhook. Saved → a one-line row (test / remove); not yet
 * saved → the narrow URL form drops under the label.
 */
function DiscordRows({ initial }: { initial: DiscordSettingsResponse }) {
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

  // The masked display id of a SAVED webhook — non-null exactly when one is
  // stored (the URL itself is never handed back), which is also what decides
  // whether this row shows the status line or the setup form.
  const webhookIdMasked =
    settings.linked && settings.webhookIdMasked ? settings.webhookIdMasked : null;

  return (
    <>
      <Row
        hint={t('settings.notifications.discord.description')}
        label={t('settings.notifications.discord.title')}
        stack={webhookIdMasked === null}
      >
        {webhookIdMasked !== null ? (
          <>
            <span className="bt-pos" style={{ fontSize: 12 }}>
              {t('settings.notifications.discord.linked', { id: webhookIdMasked })}
            </span>
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
          </>
        ) : (
          <PanelForm
            onSubmit={(event) => {
              event.preventDefault();
              saveMutation.mutate(url.trim());
            }}
          >
            <Field htmlFor="discordWebhookUrl" label={t('settings.notifications.discord.urlLabel')}>
              <Input
                id="discordWebhookUrl"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t('settings.notifications.discord.urlPlaceholder')}
                required
              />
            </Field>
            <Button
              className="self-start"
              size="sm"
              type="submit"
              disabled={saveMutation.isPending || url.trim() === ''}
            >
              {saveMutation.isPending
                ? t('settings.notifications.discord.saving')
                : t('settings.notifications.discord.save')}
            </Button>
          </PanelForm>
        )}
      </Row>
      {saveErrorKey ? (
        <Row>
          <Alert tone="error">{t(saveErrorKey)}</Alert>
        </Row>
      ) : null}
      {testResult === 'ok' ? (
        <Row>
          <Alert tone="success">{t('settings.notifications.discord.testSuccess')}</Alert>
        </Row>
      ) : null}
      {testResult === 'error' ? (
        <Row>
          <Alert tone="error">{t('settings.notifications.discord.testFailed')}</Alert>
        </Row>
      ) : null}
      {removeMutation.isError ? (
        <Row>
          <Alert tone="error">{t('settings.notifications.discord.removeError')}</Alert>
        </Row>
      ) : null}
    </>
  );
}

/** Extract the API error code from an `ApiError` thrown by `apiRequest`. */
function readErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : null;
}

/**
 * Fetches the Telegram state and renders the row when the deployment offers
 * Telegram (V5-P0 kill-switch parent gate + bot token set). When the
 * kill-switch is off the parent skips rendering this entirely, so this never
 * probes `/settings/telegram` and the setup endpoints stay 404-only.
 */
function TelegramSetup() {
  const query = useQuery({
    queryKey: TELEGRAM_KEY,
    queryFn: ({ signal }) => getTelegramSettings(signal),
    staleTime: 15_000,
  });
  if (!query.data || !query.data.available) return null;
  return <TelegramRows initial={query.data} />;
}

/**
 * Discord is available server-side whenever the V5-P0 kill-switch is on. Its
 * rendering is gated by the parent on `channelsConfigurable.discord`, so the
 * setup row never probes `/settings/discord` while the flag is off.
 */
function DiscordSetup() {
  const query = useQuery({
    queryKey: DISCORD_KEY,
    queryFn: ({ signal }) => getDiscordSettings(signal),
    staleTime: 15_000,
  });
  if (!query.data) return null;
  return <DiscordRows initial={query.data} />;
}

/**
 * Per-browser web-push opt-in (#368/#350): rendered only when the deployment
 * has VAPID configured. The permission prompt is triggered exclusively by the
 * enable button here — never on panel load.
 */
function WebPushRow({ publicKey }: { publicKey: string }) {
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
    <>
      <Row
        hint={t('settings.notifications.webPush.description')}
        label={t('settings.notifications.webPush.title')}
      >
        {!supported ? (
          <span className="bt-meta">{t('settings.notifications.webPush.unsupported')}</span>
        ) : state === 'denied' ? (
          <Badge tone="gold">{t('settings.notifications.webPush.denied')}</Badge>
        ) : (
          <>
            {state === 'enabled' ? (
              <span className="bt-pos" style={{ fontSize: 12 }}>
                {t('settings.notifications.webPush.enabled')}
              </span>
            ) : null}
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
          </>
        )}
      </Row>
      {error ? (
        <Row>
          <Alert tone="error">{t('settings.notifications.webPush.error')}</Alert>
        </Row>
      ) : null}
    </>
  );
}

/**
 * Control Center → Notifications: WHERE each kind of activity goes. The global
 * mute and the per-browser push opt-in, the outbound channels a user has to set
 * up (Telegram, Discord), the routing matrix, and the two timing disclosures —
 * all wired to `GET/PATCH /settings/notifications`, one mutation for the lot.
 */
export function NotificationsPanel() {
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

  if (query.isPending) {
    return (
      <div className="bt-cc-panel">
        <PanelHead title={t('control.notifications')} />
        <div className="flex flex-col gap-2">
          <Skeleton height="h-8" />
          <Skeleton height="h-8" />
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="bt-cc-panel">
        <PanelHead title={t('control.notifications')} />
        <EmptyState
          compact
          description={t('settings.retryHint')}
          title={t('settings.notifications.loadError.title')}
        />
      </div>
    );
  }

  const settings = query.data;
  const busy = mutation.isPending;
  const onUpdate = (patch: UpdateNotificationSettingsRequest) => mutation.mutate(patch);
  const hasChannelSetup =
    settings.channelsConfigurable.telegram || settings.channelsConfigurable.discord;

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.notifications')} />

      <PanelGroup label={t('settings.notifications.groups.general')}>
        <Row
          hint={t('settings.notifications.mute.description')}
          label={t('settings.notifications.mute.label')}
        >
          <input
            type="checkbox"
            role="switch"
            aria-label={t('settings.notifications.mute.label')}
            checked={settings.muted}
            disabled={busy}
            onChange={(event) => mutation.mutate({ muted: event.target.checked })}
            className={cx('h-4 w-4', busy && 'cursor-not-allowed')}
            style={{ accentColor: 'var(--bt-gold)', opacity: busy ? 0.5 : undefined }}
          />
        </Row>
        {settings.channels.webpush && settings.webPushPublicKey ? (
          <WebPushRow publicKey={settings.webPushPublicKey} />
        ) : null}
      </PanelGroup>

      {hasChannelSetup ? (
        <PanelGroup label={t('settings.notifications.groups.channels')}>
          {settings.channelsConfigurable.telegram ? <TelegramSetup /> : null}
          {settings.channelsConfigurable.discord ? <DiscordSetup /> : null}
        </PanelGroup>
      ) : null}

      <PanelGroup label={t('settings.notifications.groups.routing')}>
        <Row stack>
          <NotificationMatrixGrid settings={settings} busy={busy} onUpdate={onUpdate} />
        </Row>
      </PanelGroup>

      <PanelGroup label={t('settings.notifications.groups.timing')}>
        <CadenceFold settings={settings} busy={busy} onUpdate={onUpdate} />
        <QuietHoursFold settings={settings} busy={busy} onUpdate={onUpdate} />
      </PanelGroup>

      {mutation.isError ? (
        <Alert tone="error">{t('settings.notifications.grid.saveError')}</Alert>
      ) : null}
    </div>
  );
}
