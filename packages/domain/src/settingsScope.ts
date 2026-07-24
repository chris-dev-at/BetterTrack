/**
 * Per-portfolio settings scoping (issue #636). Any setting that can sensibly be
 * scoped per portfolio resolves through one cascade:
 *
 *   effective(setting, portfolio) = portfolio override ?? user default ?? system default
 *
 * This is the pure heart of the framework — the three layers are read by the
 * caller (each `null`/`undefined` when that layer is unset) and folded here into
 * the effective value plus the layer it came from. The `source` powers the
 * "inheriting default / overridden" UI: a portfolio with no override tracks the
 * user's LIVE default (link semantics — see PROJECTPLAN.md §16, 2026-07-21), so
 * later changing a default retro-affects portfolios that never overrode, and a
 * reset-to-default simply drops the override back to inheriting.
 *
 * Domain code: no I/O, imports nothing but types.
 */

/** Which scope a resolved per-portfolio setting was taken from. */
export type SettingSource = 'portfolio' | 'user' | 'system';

/** A resolved setting: its effective value and the layer that supplied it. */
export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

/**
 * Fold the three scoping layers into the effective value. A layer counts as
 * "set" when it is neither `null` nor `undefined`; the first set layer, walked
 * override → user default → system default, wins. The system default is always
 * a concrete value, so a `ResolvedSetting` never has an absent `value`.
 */
export function resolvePortfolioSetting<T>(
  override: T | null | undefined,
  userDefault: T | null | undefined,
  systemDefault: T,
): ResolvedSetting<T> {
  if (override !== null && override !== undefined) {
    return { value: override, source: 'portfolio' };
  }
  if (userDefault !== null && userDefault !== undefined) {
    return { value: userDefault, source: 'user' };
  }
  return { value: systemDefault, source: 'system' };
}
