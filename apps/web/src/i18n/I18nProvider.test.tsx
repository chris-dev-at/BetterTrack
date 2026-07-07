import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { I18nProvider, useI18n, useT } from './index';
import { resolveLocaleCode } from './registry';

/**
 * The SPA i18n runtime (§13.3 V3-P1): EN is the default and the fallback, DE is
 * the first translation, unknown/region-tagged codes resolve gracefully, and
 * `{{token}}` interpolation works.
 */
function Probe() {
  const { locale } = useI18n();
  const t = useT();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="known">{t('common.save')}</span>
      <span data-testid="missing">{t('this.key.does.not.exist')}</span>
      <span data-testid="interp">{t('settings.password.hint', { count: 8 })}</span>
    </div>
  );
}

describe('resolveLocaleCode', () => {
  test('maps known, region-tagged, unknown and empty codes to a renderable locale', () => {
    expect(resolveLocaleCode('de')).toBe('de');
    expect(resolveLocaleCode('de-AT')).toBe('de'); // region-tagged → primary subtag
    expect(resolveLocaleCode('xx')).toBe('en'); // unknown → EN default
    expect(resolveLocaleCode(null)).toBe('en');
    expect(resolveLocaleCode(undefined)).toBe('en');
  });
});

describe('I18nProvider', () => {
  test('renders EN by default and for an unknown locale', () => {
    render(
      <I18nProvider initialLocale="xx">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('known').textContent).toBe('Save');
    expect(screen.getByTestId('interp').textContent).toBe('At least 8 characters.');
  });

  test('renders German for a de recipient and interpolates', () => {
    render(
      <I18nProvider initialLocale="de">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('de');
    expect(screen.getByTestId('known').textContent).toBe('Speichern');
    expect(screen.getByTestId('interp').textContent).toBe('Mindestens 8 Zeichen.');
  });

  test('an entirely unknown key renders the key itself, never a crash', () => {
    render(
      <I18nProvider initialLocale="de">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('missing').textContent).toBe('this.key.does.not.exist');
  });
});
