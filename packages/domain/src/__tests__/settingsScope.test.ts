import { describe, expect, it } from 'vitest';

import { resolvePortfolioSetting } from '../settingsScope';

describe('resolvePortfolioSetting (per-portfolio scoping cascade, #636)', () => {
  const SYSTEM = { mode: 'none' } as const;

  it('takes the portfolio override when it is set (highest precedence)', () => {
    const resolved = resolvePortfolioSetting({ mode: 'override' }, { mode: 'user' }, SYSTEM);
    expect(resolved).toEqual({ value: { mode: 'override' }, source: 'portfolio' });
  });

  it('falls back to the user default when no override is set', () => {
    const resolved = resolvePortfolioSetting(null, { mode: 'user' }, SYSTEM);
    expect(resolved).toEqual({ value: { mode: 'user' }, source: 'user' });
  });

  it('falls back to the system default when neither override nor user default is set', () => {
    const resolved = resolvePortfolioSetting(null, null, SYSTEM);
    expect(resolved).toEqual({ value: SYSTEM, source: 'system' });
  });

  it('treats undefined like null at both layers', () => {
    expect(resolvePortfolioSetting(undefined, undefined, SYSTEM).source).toBe('system');
    expect(resolvePortfolioSetting(undefined, { mode: 'user' }, SYSTEM).source).toBe('user');
  });

  it('honours a falsy-but-present override value (0 is a real value, not "unset")', () => {
    // The cascade keys off null/undefined only — a legitimate falsy value like 0
    // or '' must still count as an override, never fall through.
    expect(resolvePortfolioSetting(0, 5, 9)).toEqual({ value: 0, source: 'portfolio' });
    expect(resolvePortfolioSetting('', 'u', 's')).toEqual({ value: '', source: 'portfolio' });
    expect(resolvePortfolioSetting(false, true, true)).toEqual({
      value: false,
      source: 'portfolio',
    });
  });

  it('honours a falsy-but-present user default when the override is unset', () => {
    expect(resolvePortfolioSetting(null, 0, 9)).toEqual({ value: 0, source: 'user' });
  });
});
