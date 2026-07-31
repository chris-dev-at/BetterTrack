import { useEffect, useState } from 'react';

import {
  NOTIFICATION_SETTING_CHANNELS,
  NOTIFICATION_TYPES,
  type AccountDefaultsResponse,
  type NotificationChannelsConfigurable,
  type NotificationMatrix,
  type NotificationSettingChannel,
  type NotificationType,
  type PortfolioVisibility,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner } from '../components/ui';

function errorMessage(err: unknown, t: TranslateFn): string {
  return err instanceof ApiError ? err.message : t('common.genericError');
}

function channelLabels(t: TranslateFn): Record<NotificationSettingChannel, string> {
  return {
    inapp: t('admin.accountDefaults.channels.inapp'),
    email: t('admin.accountDefaults.channels.email'),
    telegram: t('admin.accountDefaults.channels.telegram'),
    discord: t('admin.accountDefaults.channels.discord'),
    push: t('admin.accountDefaults.channels.push'),
    webpush: t('admin.accountDefaults.channels.webpush'),
  };
}

function notificationTypeLabels(t: TranslateFn): Record<NotificationType, string> {
  return {
    'friend.request': t('admin.accountDefaults.types.friendRequest'),
    'friend.accepted': t('admin.accountDefaults.types.friendAccepted'),
    'portfolio.shared': t('admin.accountDefaults.types.portfolioShared'),
    'watchlist.shared': t('admin.accountDefaults.types.watchlistShared'),
    'conglomerate.shared': t('admin.accountDefaults.types.conglomerateShared'),
    'friend.activity': t('admin.accountDefaults.types.friendActivity'),
    'follow.published': t('admin.accountDefaults.types.followPublished'),
    'follow.alert.created': t('admin.accountDefaults.types.followAlertCreated'),
    'follow.alert.fired': t('admin.accountDefaults.types.followAlertFired'),
    'account.invite': t('admin.accountDefaults.types.accountInvite'),
    'account.temp_password': t('admin.accountDefaults.types.tempPassword'),
    'account.data_export': t('admin.accountDefaults.types.dataExport'),
    'alert.triggered': t('admin.accountDefaults.types.alertTriggered'),
    'earnings.reminder': t('admin.accountDefaults.types.earningsReminder'),
    'chat.message': t('admin.accountDefaults.types.chatMessage'),
    'dividend.event': t('admin.accountDefaults.types.dividendEvent'),
    'budget.exceeded': t('admin.accountDefaults.types.budgetExceeded'),
    'mirror.invite': t('admin.accountDefaults.types.mirrorInvite'),
    'mirror.member_joined': t('admin.accountDefaults.types.mirrorMemberJoined'),
    'mirror.member_left': t('admin.accountDefaults.types.mirrorMemberLeft'),
    'mirror.member_removed': t('admin.accountDefaults.types.mirrorMemberRemoved'),
    'mirror.removed': t('admin.accountDefaults.types.mirrorRemoved'),
    'mirror.ownership_transferred': t('admin.accountDefaults.types.mirrorOwnershipTransferred'),
    'mirror.chain_dissolved': t('admin.accountDefaults.types.mirrorChainDissolved'),
    'mirror.sync_stalled': t('admin.accountDefaults.types.mirrorSyncStalled'),
  };
}

/**
 * New-account defaults (PROJECTPLAN.md §13.4 V4-P0d): what EVERY new account
 * starts with — chat on/off, default portfolio visibility, an inert
 * developer-status flag consumed only when V6-9 ships, and the seed notification
 * matrix (pre-filled with the V4-P0c lean email default). A change applies to the
 * NEXT registration only; existing accounts are never touched. Reads via
 * `GET /admin/account-defaults` and persists via `PATCH` (audit-logged).
 */
export function AccountDefaultsPage() {
  const t = useT();
  const defaults = useResource((signal) => api.getAccountDefaults(signal), []);
  const { data } = defaults;

  const [chatEnabled, setChatEnabled] = useState(true);
  const [visibility, setVisibility] = useState<PortfolioVisibility>('private');
  const [developerStatus, setDeveloperStatus] = useState(false);
  const [matrix, setMatrix] = useState<NotificationMatrix | null>(null);
  // V5-P0 kill-switch: which of the additive channels this deployment offers
  // at all. Off ⇒ the matrix editor hides those columns entirely.
  const [channelsConfigurable, setChannelsConfigurable] =
    useState<NotificationChannelsConfigurable>({ telegram: true, discord: true });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editable form from the stored defaults once they load.
  useEffect(() => {
    if (!data) return;
    setChatEnabled(data.chatEnabled);
    setVisibility(data.defaultPortfolioVisibility);
    setDeveloperStatus(data.developerStatus);
    setMatrix(data.notificationMatrix);
    setChannelsConfigurable(data.channelsConfigurable);
  }, [data]);

  // Only render channels this deployment actually offers — the V5-P0 kill-switch
  // hides Telegram + Discord columns when the flag is off.
  const visibleChannels = NOTIFICATION_SETTING_CHANNELS.filter((channel) => {
    if (channel === 'telegram') return channelsConfigurable.telegram;
    if (channel === 'discord') return channelsConfigurable.discord;
    return true;
  });
  const channelLabel = channelLabels(t);
  const typeLabel = notificationTypeLabels(t);

  function setCell(type: NotificationType, channel: NotificationSettingChannel, value: boolean) {
    setSaved(false);
    setMatrix((prev) => (prev ? { ...prev, [type]: { ...prev[type], [channel]: value } } : prev));
  }

  async function onSave() {
    if (!matrix) return;
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const next: AccountDefaultsResponse = await api.updateAccountDefaults({
        chatEnabled,
        defaultPortfolioVisibility: visibility,
        developerStatus,
        notificationMatrix: matrix,
      });
      setChatEnabled(next.chatEnabled);
      setVisibility(next.defaultPortfolioVisibility);
      setDeveloperStatus(next.developerStatus);
      setMatrix(next.notificationMatrix);
      setChannelsConfigurable(next.channelsConfigurable);
      setSaved(true);
    } catch (err) {
      setSaveError(errorMessage(err, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('admin.accountDefaults.title')}
        description={t('admin.accountDefaults.subtitle')}
      />

      {defaults.loading ? (
        <Spinner label={t('admin.accountDefaults.loading')} />
      ) : defaults.error ? (
        <Alert tone="error">
          {defaults.error}{' '}
          <button className="underline" onClick={defaults.reload}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : matrix ? (
        <>
          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              {t('admin.accountDefaults.starterTitle')}
            </h2>

            <label
              htmlFor="default-chat-enabled"
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-700 px-3 py-3"
            >
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium text-neutral-100">
                  {t('admin.accountDefaults.chatLabel')}
                </span>
                <span className="text-sm text-neutral-400">
                  {t('admin.accountDefaults.chatHint')}
                </span>
              </span>
              <input
                id="default-chat-enabled"
                type="checkbox"
                className="mt-1 h-4 w-4 accent-sky-500"
                checked={chatEnabled}
                onChange={(e) => {
                  setSaved(false);
                  setChatEnabled(e.target.checked);
                }}
              />
            </label>

            <fieldset
              className="flex flex-col gap-2 rounded-md border border-neutral-700 px-3 py-3"
              aria-label={t('admin.accountDefaults.visibilityAria')}
            >
              <legend className="px-1 text-sm font-medium text-neutral-100">
                {t('admin.accountDefaults.visibilityTitle')}
              </legend>
              {(['private', 'friends'] as const).map((value) => (
                <label
                  key={value}
                  htmlFor={`default-visibility-${value}`}
                  className="flex items-center gap-3 text-sm text-neutral-300"
                >
                  <input
                    id={`default-visibility-${value}`}
                    type="radio"
                    name="default-visibility"
                    className="accent-sky-500"
                    value={value}
                    checked={visibility === value}
                    onChange={() => {
                      setSaved(false);
                      setVisibility(value);
                    }}
                  />
                  {value === 'private'
                    ? t('admin.accountDefaults.visibilityPrivate')
                    : t('admin.accountDefaults.visibilityFriends')}
                </label>
              ))}
            </fieldset>

            <label
              htmlFor="default-developer-status"
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-700 px-3 py-3"
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                  {t('admin.accountDefaults.developerLabel')}
                  <Badge tone="neutral">{t('admin.accountDefaults.inertBadge')}</Badge>
                </span>
                <span className="text-sm text-neutral-400">
                  {t('admin.accountDefaults.developerHint')}
                </span>
              </span>
              <input
                id="default-developer-status"
                type="checkbox"
                className="mt-1 h-4 w-4 accent-sky-500"
                checked={developerStatus}
                onChange={(e) => {
                  setSaved(false);
                  setDeveloperStatus(e.target.checked);
                }}
              />
            </label>
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                {t('admin.accountDefaults.notificationsTitle')}
              </h2>
              <p className="text-sm text-neutral-400">
                {t('admin.accountDefaults.notificationsDescription')}
              </p>
            </div>

            <div className="overflow-x-auto rounded-md border border-neutral-800">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">
                      {t('admin.accountDefaults.typeHeader')}
                    </th>
                    {visibleChannels.map((channel) => (
                      <th key={channel} className="px-3 py-2 text-center font-medium">
                        {channelLabel[channel]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800">
                  {NOTIFICATION_TYPES.map((type) => (
                    <tr key={type} className="hover:bg-neutral-900/60">
                      <td className="px-4 py-2 font-mono text-xs text-neutral-300">
                        {typeLabel[type]}
                      </td>
                      {visibleChannels.map((channel) => (
                        <td key={channel} className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-sky-500"
                            aria-label={`${typeLabel[type]} · ${channelLabel[channel]}`}
                            checked={matrix[type][channel]}
                            onChange={(e) => setCell(type, channel, e.target.checked)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {saveError ? <Alert tone="error">{saveError}</Alert> : null}
          {saved ? <Alert tone="success">{t('admin.accountDefaults.saved')}</Alert> : null}

          <div>
            <Button onClick={() => void onSave()} disabled={saving}>
              {saving ? t('common.saving') : t('admin.accountDefaults.save')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
