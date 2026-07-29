import { useSyncExternalStore } from 'react';

/**
 * Open/closed state for the floating {@link AskDock} AI panel.
 *
 * The trigger is the rail's "Ask BetterTrack" utility row and the panel is
 * mounted at the shell root — two places far apart in the tree — so the state is
 * a tiny module store (the `portfolioKinds.ts` pattern) rather than props
 * threaded through `OriginShell` or another context provider. That keeps the
 * heavily-tuned rail's diff to the one row that became a toggle.
 *
 * Only whether the panel was open persists. It carries no conversation and no
 * tab: the friend chat is a separate thing entirely now (the `/people/chat` page
 * and its pop-out window), not a second mode of this panel.
 */

const STORAGE_KEY = 'bt.askdock';

/**
 * Cached snapshot. `useSyncExternalStore` requires a stable value between
 * notifications, so the parsed state is memoised and only replaced on a write.
 */
let snapshot: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (snapshot !== null) return snapshot;
  try {
    snapshot = localStorage.getItem(STORAGE_KEY) === 'open';
  } catch {
    // Private-mode / disabled storage: the panel is a convenience, so degrade to
    // "closed" rather than breaking the shell.
    snapshot = false;
  }
  return snapshot;
}

function write(open: boolean): void {
  snapshot = open;
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // Write failed (quota/private mode) — the in-memory snapshot still updates,
    // so this session stays consistent; it just won't survive a reload.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Open or close the panel. */
export function setAskDockOpen(open: boolean): void {
  if (read() === open) return;
  write(open);
}

/** Flip the panel open/closed — what the rail's Ask row does. */
export function toggleAskDock(): void {
  write(!read());
}

/** Test/teardown helper: drop the in-memory snapshot so storage is re-read. */
export function resetAskDockCache(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

/** Subscribe to the panel's open state. */
export function useAskDockOpen(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
