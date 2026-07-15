import { useEffect, useState } from 'react';

import {
  NOTIFICATION_SETTING_CHANNELS,
  NOTIFICATION_TYPES,
  type AccountDefaults,
  type NotificationMatrix,
  type NotificationSettingChannel,
  type NotificationType,
  type PortfolioVisibility,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner } from '../components/ui';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

/** Plain-language labels for the notification-matrix channel columns. */
const CHANNEL_LABEL: Record<NotificationSettingChannel, string> = {
  inapp: 'In-app',
  email: 'Email',
  push: 'Phone',
  webpush: 'Browser',
};

/**
 * New-account defaults (PROJECTPLAN.md §13.4 V4-P0d): what EVERY new account
 * starts with — chat on/off, default portfolio visibility, an inert
 * developer-status flag consumed only when V6-9 ships, and the seed notification
 * matrix (pre-filled with the V4-P0c lean email default). A change applies to the
 * NEXT registration only; existing accounts are never touched. Reads via
 * `GET /admin/account-defaults` and persists via `PATCH` (audit-logged).
 */
export function AccountDefaultsPage() {
  const defaults = useResource((signal) => api.getAccountDefaults(signal), []);
  const { data } = defaults;

  const [chatEnabled, setChatEnabled] = useState(true);
  const [visibility, setVisibility] = useState<PortfolioVisibility>('private');
  const [developerStatus, setDeveloperStatus] = useState(false);
  const [matrix, setMatrix] = useState<NotificationMatrix | null>(null);
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
  }, [data]);

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
      const next: AccountDefaults = await api.updateAccountDefaults({
        chatEnabled,
        defaultPortfolioVisibility: visibility,
        developerStatus,
        notificationMatrix: matrix,
      });
      setChatEnabled(next.chatEnabled);
      setVisibility(next.defaultPortfolioVisibility);
      setDeveloperStatus(next.developerStatus);
      setMatrix(next.notificationMatrix);
      setSaved(true);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account defaults"
        description="What every NEW account starts with. Changes apply to the next registration only — existing accounts are never touched."
      />

      {defaults.loading ? (
        <Spinner label="Loading account defaults…" />
      ) : defaults.error ? (
        <Alert tone="error">
          {defaults.error}{' '}
          <button className="underline" onClick={defaults.reload}>
            Retry
          </button>
        </Alert>
      ) : matrix ? (
        <>
          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Starter settings
            </h2>

            <label
              htmlFor="default-chat-enabled"
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-700 px-3 py-3"
            >
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium text-neutral-100">Chat enabled</span>
                <span className="text-sm text-neutral-500">
                  When off, new accounts start unable to send direct messages (they can still read).
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
              aria-label="Default portfolio visibility"
            >
              <legend className="px-1 text-sm font-medium text-neutral-100">
                Default portfolio visibility
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
                  {value === 'private' ? 'Private' : 'Visible to friends'}
                </label>
              ))}
            </fieldset>

            <label
              htmlFor="default-developer-status"
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-700 px-3 py-3"
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                  Developer status
                  <Badge tone="neutral">Inert</Badge>
                </span>
                <span className="text-sm text-neutral-500">
                  Stored on new accounts but has no effect yet — consumed only when developer status
                  ships (V6-9).
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
                Notification defaults
              </h2>
              <p className="text-sm text-neutral-500">
                The per-type × channel matrix a new account starts with. Pre-filled with the lean
                email default (email on only for account &amp; security). Users can change theirs
                afterwards.
              </p>
            </div>

            <div className="overflow-x-auto rounded-md border border-neutral-800">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Type</th>
                    {NOTIFICATION_SETTING_CHANNELS.map((channel) => (
                      <th key={channel} className="px-3 py-2 text-center font-medium">
                        {CHANNEL_LABEL[channel]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800">
                  {NOTIFICATION_TYPES.map((type) => (
                    <tr key={type} className="hover:bg-neutral-900/60">
                      <td className="px-4 py-2 font-mono text-xs text-neutral-300">{type}</td>
                      {NOTIFICATION_SETTING_CHANNELS.map((channel) => (
                        <td key={channel} className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-sky-500"
                            aria-label={`${type} · ${CHANNEL_LABEL[channel]}`}
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
          {saved ? <Alert tone="success">Account defaults saved.</Alert> : null}

          <div>
            <Button onClick={() => void onSave()} disabled={saving}>
              {saving ? 'Saving…' : 'Save defaults'}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
