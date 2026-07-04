import { useEffect, useState } from 'react';

import { REGISTRATION_MODES, type RegistrationMode } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner, cx } from '../components/ui';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

interface ModeMeta {
  mode: RegistrationMode;
  title: string;
  description: string;
  /** V1 only enforces `closed`; the rest are designed + stored but not yet active. */
  available: boolean;
}

/**
 * The four registration modes (PROJECTPLAN.md §6.12), in enforcement order. Only
 * `closed` is selectable in V1; the enforcement plumbing already reads this setting
 * so activating a mode later is a switch, not a rebuild.
 */
const MODE_META: ModeMeta[] = [
  {
    mode: 'closed',
    title: 'Closed',
    description: 'Only admin-created users and invite links. The V1 default, fully enforced.',
    available: true,
  },
  {
    mode: 'invite_token',
    title: 'Invite / access-token',
    description: 'Self-serve registration page that requires a valid token.',
    available: false,
  },
  {
    mode: 'approval',
    title: 'Approval',
    description: 'Open registration form; accounts land as pending until an admin approves.',
    available: false,
  },
  {
    mode: 'open',
    title: 'Open',
    description: 'Automatic registration — anyone can create an account.',
    available: false,
  },
];

// Guard against a mode being added to the contract without a UI entry here.
if (MODE_META.length !== REGISTRATION_MODES.length) {
  throw new Error('Registration-mode UI is out of sync with the contract enum.');
}

/**
 * Admin global settings (PROJECTPLAN.md §6.12, §8): the registration-mode selector
 * and a beta-mode toggle placeholder. Reads the stored state via `GET /admin/settings`
 * and persists edits via `PATCH /admin/settings`. In V1 only `closed` is selectable;
 * the other modes render disabled + "Coming soon".
 */
export function SettingsPage() {
  const settings = useResource((signal) => api.getSettings(signal), []);
  const { data } = settings;

  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('closed');
  const [betaMode, setBetaMode] = useState(false);
  // The last-known persisted values, so we can flag unsaved edits without a refetch.
  const [baseline, setBaseline] = useState<{ registrationMode: RegistrationMode; betaMode: boolean } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editable form from the stored settings once they load.
  useEffect(() => {
    if (!data) return;
    setRegistrationMode(data.registrationMode);
    setBetaMode(data.betaMode);
    setBaseline({ registrationMode: data.registrationMode, betaMode: data.betaMode });
  }, [data]);

  const dirty =
    baseline != null &&
    (registrationMode !== baseline.registrationMode || betaMode !== baseline.betaMode);

  async function onSave() {
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const next = await api.updateSettings({ registrationMode, betaMode });
      setRegistrationMode(next.registrationMode);
      setBetaMode(next.betaMode);
      setBaseline({ registrationMode: next.registrationMode, betaMode: next.betaMode });
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
        title="Settings"
        description="Global app configuration — how accounts come to exist and app-wide feature toggles."
      />

      {settings.loading ? (
        <Spinner label="Loading settings…" />
      ) : settings.error ? (
        <Alert tone="error">{settings.error}</Alert>
      ) : (
        <>
          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Registration mode
              </h2>
              <p className="text-sm text-neutral-500">
                How new accounts come to exist. Only Closed is available in V1; the others are
                designed and enforced from day one but activate post-v1.
              </p>
            </div>

            <fieldset className="flex flex-col gap-2" aria-label="Registration mode">
              {MODE_META.map((meta) => {
                const selected = registrationMode === meta.mode;
                const inputId = `registration-mode-${meta.mode}`;
                return (
                  <label
                    key={meta.mode}
                    htmlFor={inputId}
                    className={cx(
                      'flex items-start gap-3 rounded-md border px-3 py-3',
                      meta.available
                        ? 'cursor-pointer border-neutral-700 hover:border-neutral-600'
                        : 'cursor-not-allowed border-neutral-800 opacity-60',
                      selected && meta.available ? 'border-sky-600 bg-sky-950/30' : null,
                    )}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="registration-mode"
                      className="mt-1 accent-sky-500"
                      value={meta.mode}
                      checked={selected}
                      disabled={!meta.available}
                      onChange={() => setRegistrationMode(meta.mode)}
                    />
                    <span className="flex flex-col gap-1">
                      <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                        {meta.title}
                        {meta.available ? null : <Badge tone="amber">Coming soon</Badge>}
                      </span>
                      <span className="text-sm text-neutral-500">{meta.description}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Feature toggles
              </h2>
              <p className="text-sm text-neutral-500">
                App-wide feature flags and access rules live here. More toggles land post-v1.
              </p>
            </div>

            <label
              htmlFor="beta-mode"
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-700 px-3 py-3"
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                  Beta mode
                  <Badge tone="neutral">Placeholder</Badge>
                </span>
                <span className="text-sm text-neutral-500">
                  Gate experimental surfaces behind a beta flag. No app behaviour depends on it yet.
                </span>
              </span>
              <input
                id="beta-mode"
                type="checkbox"
                className="mt-1 h-4 w-4 accent-sky-500"
                checked={betaMode}
                onChange={(e) => setBetaMode(e.target.checked)}
              />
            </label>
          </section>

          {saveError ? <Alert tone="error">{saveError}</Alert> : null}
          {saved && !dirty ? <Alert tone="success">Settings saved.</Alert> : null}

          <div className="flex items-center gap-3">
            <Button onClick={() => void onSave()} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
            {dirty ? <span className="text-sm text-neutral-500">Unsaved changes</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
