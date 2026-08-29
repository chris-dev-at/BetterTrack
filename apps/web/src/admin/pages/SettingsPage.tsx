import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useAdminMutation } from '../useAdminMutation';
import { useResource } from '../useResource';
import {
  Alert,
  AsyncReadState,
  Badge,
  Button,
  INLINE_LINK,
  PageHeader,
  Panel,
  PanelHeader,
  cx,
} from '../components/ui';
import { TEXT_MICRO, TEXT_MUTED } from '../components/tokens';

/**
 * Admin global settings (PROJECTPLAN.md §6.12, §8, §13.4 V4-P4a).
 *
 * **The registration-mode selector is no longer here** (#1406 W2, Chief ruling
 * 2026-08-29). W1 moved the approval queue and the access tokens to the People
 * workspace and left the mode behind, which left "which door is open" and "who
 * is knocking" in two different workspaces. W2 moved the selector across and
 * this page keeps a single pointer at it — one home, not two.
 *
 * What remains is the beta toggle. It is inert (a placeholder, as it has always
 * been); the owner's 2026-08-20 verdict is to DELETE it once no off-repo
 * consumer is confirmed, which is a separate change from this one.
 */
export function SettingsPage() {
  const t = useT();
  const settings = useResource((signal) => api.getSettings(signal), []);
  const { data } = settings;

  const [betaMode, setBetaMode] = useState(false);
  const [baseline, setBaseline] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editable form from the stored settings once they load.
  useEffect(() => {
    if (!data) return;
    setBetaMode(data.betaMode);
    setBaseline(data.betaMode);
  }, [data]);

  const save = useAdminMutation(
    async (next: boolean) => {
      const result = await api.updateSettings({ betaMode: next });
      setBetaMode(result.betaMode);
      setBaseline(result.betaMode);
      setSaved(true);
    },
    { errorKey: 'admin.settings.saveError' },
  );

  const dirty = baseline !== null && betaMode !== baseline;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={t('admin.nav.sections.product')}
        title={t('admin.settings.title')}
        description={t('admin.settings.subtitle')}
      />

      {settings.loading || settings.error ? (
        <AsyncReadState
          error={settings.error}
          loading={settings.loading}
          loadingLabel={t('admin.settings.loading')}
          onRetry={settings.reload}
          retryable={settings.retryable}
        />
      ) : (
        <>
          {/* The mode's ONE home is People → Registration. This is a signpost,
              not a second copy of the control. */}
          <Panel className="flex flex-wrap items-center gap-3">
            <span className={TEXT_MICRO}>{t('admin.registration.currentMode')}</span>
            <Badge tone={data?.registrationMode === 'closed' ? 'neutral' : 'sky'}>
              {data
                ? t(`admin.settings.registration.modes.${modeKey(data.registrationMode)}.title`)
                : '—'}
            </Badge>
            <Link className={cx('ml-auto text-[12px]', INLINE_LINK)} to="/admin/registration">
              {t('admin.settings.registration.movedLink')}
            </Link>
          </Panel>

          <Panel padded={false}>
            <PanelHeader
              title={t('admin.settings.features.title')}
              description={t('admin.settings.features.description')}
            />
            <div className="p-4">
              <label
                htmlFor="beta-mode"
                className="flex cursor-pointer items-start justify-between gap-3 border border-neutral-800 bg-neutral-950 px-3 py-2.5"
              >
                <span className="flex flex-col gap-1">
                  <span className="flex items-center gap-2 text-[13px] font-medium text-neutral-100">
                    {t('admin.settings.features.betaLabel')}
                    <Badge tone="neutral">{t('admin.settings.features.placeholder')}</Badge>
                  </span>
                  <span className={TEXT_MUTED}>{t('admin.settings.features.betaDescription')}</span>
                </span>
                <input
                  id="beta-mode"
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-sky-500"
                  checked={betaMode}
                  onChange={(e) => setBetaMode(e.target.checked)}
                />
              </label>

              {save.error ? (
                <div className="mt-3">
                  <Alert tone="error">{save.error}</Alert>
                </div>
              ) : null}
              {saved && !dirty ? (
                <div className="mt-3">
                  <Alert tone="success">{t('admin.settings.saved')}</Alert>
                </div>
              ) : null}

              <div className="mt-3 flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={save.pending || !dirty}
                  onClick={() => {
                    setSaved(false);
                    void save.run(betaMode);
                  }}
                >
                  {save.pending ? t('common.saving') : t('admin.settings.save')}
                </Button>
                {dirty ? <span className={TEXT_MICRO}>{t('admin.settings.unsaved')}</span> : null}
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

/** Contract mode value → its catalog sub-key (`invite_token` is camelCased). */
function modeKey(mode: string): string {
  return mode === 'invite_token' ? 'inviteToken' : mode;
}
