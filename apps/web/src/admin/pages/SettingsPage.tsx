import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { REGISTRATION_MODES, type RegistrationMode } from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner, cx } from '../components/ui';

function errorMessage(err: unknown, t: TranslateFn): string {
  void err;
  return t('common.genericError');
}

interface ModeMeta {
  mode: RegistrationMode;
  title: string;
  description: string;
}

/**
 * The four registration modes (PROJECTPLAN.md §6.12, §13.4 V4-P4a), in
 * enforcement order. All four are live: switching the mode takes effect
 * immediately (no restart).
 */
function modeMeta(t: TranslateFn): ModeMeta[] {
  return [
    {
      mode: 'closed',
      title: t('admin.settings.registration.modes.closed.title'),
      description: t('admin.settings.registration.modes.closed.description'),
    },
    {
      mode: 'invite_token',
      title: t('admin.settings.registration.modes.inviteToken.title'),
      description: t('admin.settings.registration.modes.inviteToken.description'),
    },
    {
      mode: 'approval',
      title: t('admin.settings.registration.modes.approval.title'),
      description: t('admin.settings.registration.modes.approval.description'),
    },
    {
      mode: 'open',
      title: t('admin.settings.registration.modes.open.title'),
      description: t('admin.settings.registration.modes.open.description'),
    },
  ];
}

/**
 * Admin global settings (PROJECTPLAN.md §6.12, §8, §13.4 V4-P4a): the
 * registration-mode selector and the beta toggle. Reads state via
 * `GET /admin/settings` and persists edits via `PATCH`.
 *
 * The two surfaces the self-serve modes need — registration access tokens and
 * the approval queue — moved to the People workspace's Registration page with
 * the #1406 W1 IA; this page links to them instead of hosting them.
 */
export function SettingsPage() {
  const t = useT();
  const settings = useResource((signal) => api.getSettings(signal), []);
  const { data } = settings;
  const modes = modeMeta(t);

  if (modes.length !== REGISTRATION_MODES.length) {
    throw new Error('Registration-mode UI is out of sync with the contract enum.');
  }

  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('closed');
  const [betaMode, setBetaMode] = useState(false);
  // The last-known persisted values, so we can flag unsaved edits without a refetch.
  const [baseline, setBaseline] = useState<{
    registrationMode: RegistrationMode;
    betaMode: boolean;
  } | null>(null);
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
      setSaveError(errorMessage(err, t));
    } finally {
      setSaving(false);
    }
  }

  // Reflect the currently-saved mode (not the unsaved edit) in the section hints.
  const savedMode = baseline?.registrationMode ?? 'closed';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.settings.title')} description={t('admin.settings.subtitle')} />

      {settings.loading ? (
        <Spinner label={t('admin.settings.loading')} />
      ) : settings.error ? (
        <Alert tone="error">
          {settings.error}{' '}
          <button className="underline" onClick={settings.reload}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : (
        <>
          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                {t('admin.settings.registration.title')}
              </h2>
              <p className="text-sm text-neutral-400">
                {t('admin.settings.registration.description')}
              </p>
            </div>

            <fieldset
              className="flex flex-col gap-2"
              aria-label={t('admin.settings.registration.title')}
            >
              {modes.map((meta) => {
                const selected = registrationMode === meta.mode;
                const inputId = `registration-mode-${meta.mode}`;
                return (
                  <label
                    key={meta.mode}
                    htmlFor={inputId}
                    className={cx(
                      'flex items-start gap-3 rounded-md border px-3 py-3',
                      'cursor-pointer border-neutral-700 hover:border-neutral-600',
                      selected ? 'border-sky-600 bg-sky-950/30' : null,
                    )}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="registration-mode"
                      className="mt-1 accent-sky-500"
                      value={meta.mode}
                      checked={selected}
                      onChange={() => setRegistrationMode(meta.mode)}
                    />
                    <span className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-neutral-100">{meta.title}</span>
                      <span className="text-sm text-neutral-400">{meta.description}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            {saveError ? <Alert tone="error">{saveError}</Alert> : null}
            {saved && !dirty ? <Alert tone="success">{t('admin.settings.saved')}</Alert> : null}

            <div className="flex items-center gap-3">
              <Button onClick={() => void onSave()} disabled={saving || !dirty}>
                {saving ? t('common.saving') : t('admin.settings.save')}
              </Button>
              {dirty ? (
                <span className="text-sm text-neutral-400">{t('admin.settings.unsaved')}</span>
              ) : null}
            </div>
          </section>

          {savedMode === 'invite_token' || savedMode === 'approval' ? (
            <p className="text-sm text-neutral-400">
              {t('admin.settings.registration.manageLead')}{' '}
              <Link
                className="text-sky-400 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                to="/admin/registration"
              >
                {t('admin.settings.registration.manageLink')}
              </Link>
            </p>
          ) : null}

          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                {t('admin.settings.features.title')}
              </h2>
              <p className="text-sm text-neutral-400">{t('admin.settings.features.description')}</p>
            </div>

            <label
              htmlFor="beta-mode"
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-700 px-3 py-3"
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                  {t('admin.settings.features.betaLabel')}
                  <Badge tone="neutral">{t('admin.settings.features.placeholder')}</Badge>
                </span>
                <span className="text-sm text-neutral-400">
                  {t('admin.settings.features.betaDescription')}
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
        </>
      )}
    </div>
  );
}
