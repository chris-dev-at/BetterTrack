import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  applyTheme,
  readThemeSetting,
  resolveTheme,
  subscribeSystemTheme,
  writeThemeSetting,
  type ResolvedTheme,
  type ThemeSetting,
} from './theme';

/**
 * React binding for the per-device theme ({@link theme}).
 *
 * A module-level store rather than a context, for the same reason `useUiScale`
 * is one: the theme is stamped on `document.documentElement` before React
 * mounts, and the React-side needs are only "let the Appearance row read and
 * change it" and "re-resolve `system` when the OS flips". A provider would have
 * to wrap the whole tree to serve two consumers of a value that is not even
 * stored in the tree.
 */

let setting: ThemeSetting = readThemeSetting();
/**
 * The RESOLVED theme, cached rather than derived at read time.
 *
 * `useSyncExternalStore` re-renders only when the snapshot VALUE changes, so a
 * store that exposed only `setting` would go silent on exactly the case the
 * watcher exists for: the OS flipping while the setting stays `system`. The
 * setting is unchanged, React bails out, and the screen keeps saying
 * "System (Dark)" on a light desktop — with `PriceChart` never rebuilding its
 * canvas. Two snapshots, one per question.
 */
let resolved: ResolvedTheme = resolveTheme(setting);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshotSetting(): ThemeSetting {
  return setting;
}

function snapshotResolved(): ResolvedTheme {
  return resolved;
}

/** Re-resolve, repaint, and wake every reader whose answer moved. */
function repaint(): void {
  resolved = resolveTheme(setting);
  applyTheme(resolved);
  emit();
}

/** The stored choice plus a setter that repaints immediately. */
export function useThemeSetting(): [ThemeSetting, (next: ThemeSetting) => void] {
  const current = useSyncExternalStore(subscribe, snapshotSetting, snapshotSetting);
  const set = useCallback((next: ThemeSetting) => {
    setting = next;
    writeThemeSetting(next);
    repaint();
  }, []);
  return [current, set];
}

/** The theme in effect right now — what `system` actually resolved to. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, snapshotResolved, snapshotResolved);
}

/**
 * Keep `system` honest while the OS preference changes under us: macOS and
 * Windows both flip at sunset on a schedule the user never revisits, and an app
 * that only reads the preference at boot stays wrong until the next reload.
 * Mounted once, by the app root. An explicit pin is left exactly where the user
 * put it — the subscription stays live either way, and simply resolves to the
 * same pinned value.
 */
export function useThemeWatcher(): void {
  useEffect(() => subscribeSystemTheme(repaint), []);
}

/** Reset the module store between tests. Not part of the app's runtime path. */
export function __resetThemeStoreForTests(): void {
  setting = readThemeSetting();
  resolved = resolveTheme(setting);
  emit();
}
