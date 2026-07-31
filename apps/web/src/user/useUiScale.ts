import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  applyUiScale,
  readDisplayProbe,
  readUiScaleSetting,
  resolveUiScale,
  writeUiScaleSetting,
  type UiScaleSetting,
} from './uiScale';

/**
 * React binding for the per-device interface scale ({@link uiScale}).
 *
 * A module-level store rather than a context: the scale is applied to
 * `document.documentElement` before React mounts, and the only React-side needs
 * are "let the settings row read and change it" and "re-evaluate `auto` when the
 * window resizes". A provider would have to wrap the whole tree to serve two
 * consumers.
 */

let setting: UiScaleSetting = readUiScaleSetting();
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

function snapshot(): UiScaleSetting {
  return setting;
}

/** The stored choice plus a setter that repaints immediately. */
export function useUiScaleSetting(): [UiScaleSetting, (next: UiScaleSetting) => void] {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((next: UiScaleSetting) => {
    setting = next;
    writeUiScaleSetting(next);
    applyUiScale(resolveUiScale(next, readDisplayProbe()));
    emit();
  }, []);
  return [current, set];
}

/** The scale in effect right now — what `auto` actually resolved to. */
export function useEffectiveUiScale(): number {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return resolveUiScale(current, readDisplayProbe());
}

/**
 * Keep `auto` honest while the window changes size: dragging a scaled window
 * narrow must give the space back rather than squeeze the desktop layout
 * ({@link autoUiScale} clamps to the effective width). Mounted once, by the app
 * root. An explicit choice is left exactly where the user put it.
 */
export function useUiScaleWatcher(): void {
  useEffect(() => {
    function reapply() {
      applyUiScale(resolveUiScale(setting, readDisplayProbe()));
    }
    window.addEventListener('resize', reapply);
    return () => window.removeEventListener('resize', reapply);
  }, []);
}
