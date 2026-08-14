import { useT } from '../../../i18n';
import { THEME_SETTINGS, type ThemeSetting } from '../../../lib/theme';
import { useResolvedTheme, useThemeSetting } from '../../../lib/useTheme';
import { Seg, Select } from '../../../ui/origin';
import { UI_SCALE_STEPS } from '../../uiScale';
import { useEffectiveUiScale, useUiScaleSetting } from '../../useUiScale';
import { PanelGroup, PanelHead, Row } from './panelKit';

type UiScaleStep = (typeof UI_SCALE_STEPS)[number];

/**
 * Appearance (board #68 item 2, "white mode"): how the app is painted on THIS
 * device.
 *
 * Its own panel rather than two more rows on Account, because both settings
 * here answer one question — "which screen am I looking at?" — and neither is
 * an account fact. Account keeps identity, language, currency and export;
 * Appearance keeps theme and interface size, the two things that change when
 * the same login moves from a laptop at night to a monitor at noon. The
 * interface-scale row moved here from Account for exactly that reason.
 */
export function AppearancePanel() {
  const t = useT();

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.appearance')} />

      <PanelGroup label={t('settings.appearance.groups.display')}>
        <ThemeRow />
        <InterfaceScaleRow />
      </PanelGroup>
    </div>
  );
}

/**
 * Theme, as three states rather than a switch.
 *
 * "System" is a standing instruction, not a starting value: it keeps following
 * `prefers-color-scheme` for as long as it is selected, which is what a machine
 * that goes light at sunrise needs. A two-state switch cannot express that — it
 * can only be flipped into a pin, silently and permanently, the first time it
 * is touched.
 *
 * The System option names what it currently resolves to, so the state of the
 * setting never has to be inferred from the brightness of the screen.
 */
function ThemeRow() {
  const t = useT();
  const [setting, setSetting] = useThemeSetting();
  const resolved = useResolvedTheme();

  const label = (option: ThemeSetting): string =>
    option === 'system'
      ? t('settings.appearance.theme.system', {
          resolved: t(`settings.appearance.theme.${resolved}`),
        })
      : t(`settings.appearance.theme.${option}`);

  return (
    <Row hint={t('settings.appearance.theme.hint')} label={t('settings.appearance.theme.title')}>
      <Seg
        ariaLabel={t('settings.appearance.theme.title')}
        onChange={setSetting}
        options={THEME_SETTINGS.map((option) => ({ value: option, label: label(option) }))}
        value={setting}
      />
    </Row>
  );
}

/**
 * Interface-scale row (owner, 2026-07-30: too small on 1× Windows monitors,
 * right as it is on the Mac). Per DEVICE, not per account — the hint says so,
 * because the same login being 100% here and 130% at work is otherwise
 * surprising. "Automatic" states what it worked out, so the number is never a
 * mystery.
 */
function InterfaceScaleRow() {
  const t = useT();
  const [setting, setSetting] = useUiScaleSetting();
  const effective = useEffectiveUiScale();

  return (
    <Row hint={t('settings.uiScale.hint')} label={t('settings.uiScale.title')}>
      <Select
        aria-label={t('settings.uiScale.title')}
        onChange={(e) =>
          setSetting(e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as UiScaleStep))
        }
        style={{ width: 'auto', maxWidth: 220 }}
        value={String(setting)}
      >
        <option value="auto">
          {t('settings.uiScale.auto', { percent: Math.round(effective * 100) })}
        </option>
        {UI_SCALE_STEPS.map((step) => (
          <option key={step} value={String(step)}>
            {`${Math.round(step * 100)} %`}
          </option>
        ))}
      </Select>
    </Row>
  );
}
